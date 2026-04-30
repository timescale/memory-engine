/**
 * MCP Server — stdio-based Model Context Protocol server.
 *
 * A thin proxy: translates MCP tool calls into engine client HTTP calls.
 * Each instance is locked to a single engine via its API key.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { CLIENT_VERSION } from "../../../version";
import {
  type AccountsClient,
  createAccountsClient,
  createClient,
  type EngineClient,
} from "../client.ts";
import { fetchAllEngines } from "../commands/engine.ts";
import { formatMemoryAsMarkdown } from "../commands/memory.ts";
import {
  addEngineApiKey,
  getEngineApiKey,
  getServerCredentials,
  parseEngineSlugFromKey,
} from "../credentials.ts";
import {
  detectFormatFromExtension,
  type ImportFormat,
  parseContent,
} from "../parsers/index.ts";
import { inOrg, resolveEngineForSession } from "./engine-resolve.ts";

// Exported so docs-links.test.ts can resolve the `${DOCS_BASE}/...` template
// literals embedded in tool descriptions back into concrete URLs.
export const DOCS_BASE = "https://docs.memory.build";
const MCP_DOCS_BASE = `${DOCS_BASE}/mcp`;

/** URL to a tool's raw Markdown documentation page. */
export function docUrl(tool: string): string {
  return `${MCP_DOCS_BASE}/${tool}.md`;
}

/**
 * MCP instructions — sent to the client during initialization.
 *
 * Points at the integration guide as raw Markdown (more token-efficient
 * for agents than parsing the rendered HTML page).
 */
const MCP_INSTRUCTIONS = `memory engine — permanent memory for AI agents. Store, search, and organize knowledge across conversations.

Integration guide: ${DOCS_BASE}/mcp-integration.md`;

// =============================================================================
// Session State
// =============================================================================

interface ActiveEngine {
  slug: string;
  name?: string;
  orgSlug?: string;
  orgName?: string;
}

interface McpSession {
  server: string;
  sessionToken?: string;
  activeEngine: ActiveEngine | null;
  clients: Map<string, EngineClient>;
}

function requireClient(session: McpSession): EngineClient {
  if (!session.activeEngine) {
    throw new Error(
      "No engine is bound to this MCP session. " +
        "Call me_session_use_engine (or run /use-memory <engine> in Claude Code) first.",
    );
  }
  const slug = session.activeEngine.slug;
  const cached = session.clients.get(slug);
  if (cached) return cached;

  const key = getEngineApiKey(session.server, slug);
  if (!key) {
    throw new Error(
      `No local API key for engine '${slug}'. ` +
        `Call me_session_provision_engine with engine='${slug}' to mint one, then retry.`,
    );
  }
  const fresh = createClient({ url: session.server, apiKey: key });
  session.clients.set(slug, fresh);
  return fresh;
}

function requireAccountsClient(session: McpSession): AccountsClient {
  if (!session.sessionToken) {
    throw new Error(
      "Not logged in: no session token in ~/.config/me/credentials.yaml. " +
        "Run `me login` outside Claude Code, then try again.",
    );
  }
  return createAccountsClient({
    url: session.server,
    sessionToken: session.sessionToken,
  });
}

// =============================================================================
// Tool Registration
// =============================================================================

function registerTools(server: McpServer, session: McpSession): void {
  // me_memory_create
  server.registerTool(
    "me_memory_create",
    {
      title: "Create Memory",
      description: `Store a new memory.

Docs: ${docUrl("me_memory_create")}`,
      inputSchema: {
        id: z
          .string()
          .optional()
          .nullable()
          .describe(
            "UUIDv7 for idempotent creates (omit or null to auto-generate)",
          ),
        content: z.string().min(1).describe("The content of the memory"),
        meta: z
          .record(z.string(), z.any())
          .optional()
          .nullable()
          .describe("Key-value metadata pairs"),
        tree: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Hierarchical path (e.g., work.projects.me). Omit or null to store at the root.",
          ),
        temporal: z
          .object({
            start: z.string().describe("ISO timestamp for start of time range"),
            end: z
              .string()
              .optional()
              .nullable()
              .describe(
                "ISO timestamp for end (omit or null for point-in-time)",
              ),
          })
          .optional()
          .nullable()
          .describe("Time range for the memory"),
      },
      annotations: {
        title: "Create Memory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.create({
        id: args.id ?? undefined,
        content: args.content,
        meta: args.meta ?? undefined,
        tree: args.tree ?? undefined,
        temporal: args.temporal
          ? {
              start: args.temporal.start,
              end: args.temporal.end ?? undefined,
            }
          : undefined,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_search
  server.registerTool(
    "me_memory_search",
    {
      title: "Search Memories",
      description: `Search and browse memories using text matching and/or filters.

Search modes: semantic (meaning), fulltext (keywords), or both (hybrid). For ordinary queries, short terms, identifiers, or exact words, prefer hybrid by setting both semantic and fulltext to the query text. Combine with tree, meta, and temporal filters. Results scored 0-1.

Docs: ${docUrl("me_memory_search")}`,
      inputSchema: {
        semantic: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Natural language query for semantic/meaning search. For short or literal queries, also set fulltext to the same value.",
          ),
        fulltext: z
          .string()
          .optional()
          .nullable()
          .describe("Keywords/phrases for BM25 exact matching"),
        grep: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Regex pattern filter on content (POSIX, case-insensitive). Applied as WHERE filter alongside other filters.",
          ),
        meta: z
          .record(z.string(), z.any())
          .optional()
          .nullable()
          .describe("Filter by metadata attributes"),
        tree: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Filter by tree path. Bare path (work.projects) matches exactly \u2014 use work.projects.* to include descendants. Supports lquery patterns (*.api.*) and ltxtquery label search (api & v2).",
          ),
        temporal: z
          .object({
            contains: z
              .string()
              .optional()
              .nullable()
              .describe("Find memories containing this point in time"),
            overlaps: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .optional()
              .nullable()
              .describe("Find memories overlapping this range"),
            within: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .optional()
              .nullable()
              .describe("Find memories fully within this range"),
          })
          .optional()
          .nullable()
          .describe("Temporal filter for search"),
        weights: z
          .object({
            fulltext: z
              .number()
              .optional()
              .nullable()
              .describe("Weight for BM25 keyword matching (0-1)"),
            semantic: z
              .number()
              .optional()
              .nullable()
              .describe("Weight for semantic similarity (0-1)"),
          })
          .optional()
          .nullable()
          .describe("Weights for hybrid search ranking"),
        candidateLimit: z
          .number()
          .int()
          .optional()
          .nullable()
          .describe(
            "Candidates per search mode before RRF fusion (0 = default 30)",
          ),
        semanticThreshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .nullable()
          .describe(
            "Minimum semantic similarity score (0-1) for vector candidates",
          ),
        limit: z
          .number()
          .int()
          .optional()
          .nullable()
          .describe("Maximum results (0 = default 10, max: 1000)"),
        order_by: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Sort direction for filter-only searches (no semantic/fulltext). Default: desc",
          ),
      },
      annotations: {
        title: "Search Memories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.search({
        semantic: args.semantic ?? undefined,
        fulltext: args.fulltext ?? undefined,
        grep: args.grep ?? undefined,
        meta: args.meta ?? undefined,
        tree: args.tree ?? undefined,
        temporal: args.temporal
          ? {
              contains: args.temporal.contains ?? undefined,
              overlaps: args.temporal.overlaps ?? undefined,
              within: args.temporal.within ?? undefined,
            }
          : undefined,
        weights: args.weights
          ? {
              fulltext: args.weights.fulltext ?? undefined,
              semantic: args.weights.semantic ?? undefined,
            }
          : undefined,
        candidateLimit:
          args.candidateLimit && args.candidateLimit > 0
            ? args.candidateLimit
            : undefined,
        limit: args.limit && args.limit > 0 ? args.limit : undefined,
        semanticThreshold: args.semanticThreshold ?? undefined,
        orderBy:
          (args.order_by as "asc" | "desc" | null | undefined) ?? undefined,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_get
  server.registerTool(
    "me_memory_get",
    {
      title: "Get Memory",
      description: `Retrieve a single memory by its ID.

Returns full memory including content, tree, meta, temporal, and embedding status. Use after search to get full details, or before update to see current state.

Docs: ${docUrl("me_memory_get")}`,
      inputSchema: {
        id: z.string().describe("The UUID of the memory"),
      },
      annotations: {
        title: "Get Memory",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.get({ id: args.id });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_update
  server.registerTool(
    "me_memory_update",
    {
      title: "Update Memory",
      description: `Modify an existing memory.

Provide the ID and any fields to change (content, tree, meta, temporal). Null fields remain unchanged. Caution: meta is fully replaced, not merged.

Docs: ${docUrl("me_memory_update")}`,
      inputSchema: {
        id: z.string().describe("The UUID of the memory to update"),
        content: z
          .string()
          .optional()
          .nullable()
          .describe("New content (omit or null to keep existing)"),
        meta: z
          .record(z.string(), z.any())
          .optional()
          .nullable()
          .describe("New metadata (omit or null to keep existing)"),
        tree: z
          .string()
          .optional()
          .nullable()
          .describe("New tree path (omit or null to keep existing)"),
        temporal: z
          .object({
            start: z.string().describe("ISO timestamp for start of time range"),
            end: z
              .string()
              .optional()
              .nullable()
              .describe(
                "ISO timestamp for end (omit or null for point-in-time)",
              ),
          })
          .optional()
          .nullable()
          .describe("Time range for the memory"),
      },
      annotations: {
        title: "Update Memory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.update({
        id: args.id,
        content: args.content ?? undefined,
        meta: args.meta ?? undefined,
        tree: args.tree ?? undefined,
        temporal: args.temporal
          ? {
              start: args.temporal.start,
              end: args.temporal.end ?? undefined,
            }
          : undefined,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_delete
  server.registerTool(
    "me_memory_delete",
    {
      title: "Delete Memory",
      description: `Permanently remove a memory by ID.

This is irreversible. Consider archiving (meta update) or moving (me_memory_mv) instead.

Docs: ${docUrl("me_memory_delete")}`,
      inputSchema: {
        id: z.string().describe("The UUID of the memory to delete"),
      },
      annotations: {
        title: "Delete Memory",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.delete({
        id: args.id,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_delete_tree
  server.registerTool(
    "me_memory_delete_tree",
    {
      title: "Delete Memory Tree",
      description: `Delete all memories under a tree prefix.

Returns count of deleted memories. Use dry_run: true to preview without deleting.

Docs: ${docUrl("me_memory_delete_tree")}`,
      inputSchema: {
        tree: z
          .string()
          .min(1)
          .describe(
            "Tree prefix \u2014 all memories at or below this path will be deleted",
          ),
        dry_run: z
          .boolean()
          .describe("Preview count without deleting (false to execute)"),
      },
      annotations: {
        title: "Delete Memory Tree",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.deleteTree({
        tree: args.tree,
        dryRun: args.dry_run,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_mv
  server.registerTool(
    "me_memory_mv",
    {
      title: "Move Memories",
      description: `Move memories from one tree prefix to another, preserving subtree structure.

Like "mv" in a filesystem — all memories under the source prefix get their prefix replaced. Use dry_run to preview.

Docs: ${docUrl("me_memory_mv")}`,
      inputSchema: {
        source: z.string().min(1).describe("Source tree prefix to move from"),
        destination: z.string().describe("Destination tree prefix to move to"),
        dry_run: z
          .boolean()
          .describe("If true, return count without moving (false to execute)"),
      },
      annotations: {
        title: "Move Memories",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.move({
        source: args.source,
        destination: args.destination,
        dryRun: args.dry_run,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_tree
  server.registerTool(
    "me_memory_tree",
    {
      title: "Memory Tree",
      description: `View the hierarchical tree structure of memories with counts at each node.

Shows how memories are organized and how many exist at each level. Use to understand the overall shape of stored knowledge before searching.

Docs: ${docUrl("me_memory_tree")}`,
      inputSchema: {
        tree: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Root path to display from (e.g., work.projects). Omit or null for full tree.",
          ),
        levels: z
          .number()
          .int()
          .optional()
          .nullable()
          .describe("Maximum depth to display (omit or null for unlimited)"),
      },
      annotations: {
        title: "Memory Tree",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const result = await requireClient(session).memory.tree({
        tree: args.tree ?? undefined,
        levels: args.levels && args.levels > 0 ? args.levels : undefined,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // me_memory_import
  server.registerTool(
    "me_memory_import",
    {
      title: "Import Memories",
      description: `Bulk import memories from a file, directory, or content string. Parses the content according to the specified format and creates all memories in one batch.

Token-efficient: prefer \`path\` over \`content\` to avoid passing large payloads through the conversation.

Docs: ${docUrl("me_memory_import")}`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Absolute path to a file or directory. Directories are imported recursively. Format is inferred from extension (.json, .yaml, .yml, .md, .ndjson, .jsonl). Mutually exclusive with content.",
          ),
        content: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Raw content to import (JSON array, YAML array, or Markdown with frontmatter). Mutually exclusive with path.",
          ),
        format: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Content format: json, yaml, or md. Required when using content, optional when using path (inferred from extension).",
          ),
      },
      annotations: {
        title: "Import Memories",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      const format = (args.format as ImportFormat) ?? undefined;
      const allMemories: Array<{
        content: string;
        id?: string;
        meta?: Record<string, unknown>;
        tree?: string;
        temporal?: { start: string; end?: string };
      }> = [];

      if (args.path) {
        const resolved = resolve(args.path);
        if (!existsSync(resolved)) {
          throw new Error(`File not found: ${args.path}`);
        }

        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          // Recursively collect and parse all supported files
          const glob = new Bun.Glob(
            "**/*.{md,markdown,yaml,yml,json,ndjson,jsonl}",
          );
          const files: string[] = [];
          for await (const file of glob.scan({
            cwd: resolved,
            absolute: true,
          })) {
            files.push(file);
          }
          files.sort();

          if (files.length === 0) {
            throw new Error(
              `No supported files found in directory: ${args.path}`,
            );
          }

          for (const filePath of files) {
            const rawContent = await readFile(filePath, "utf-8");
            const detected = detectFormatFromExtension(filePath);
            const memories = parseContent(rawContent, {
              format: format ?? detected ?? undefined,
              filename: filePath,
            });
            for (const mem of memories) {
              allMemories.push({
                content: mem.content,
                ...(mem.id ? { id: mem.id } : {}),
                ...(mem.meta ? { meta: mem.meta } : {}),
                ...(mem.tree ? { tree: mem.tree } : {}),
                ...(mem.temporal ? { temporal: mem.temporal } : {}),
              });
            }
          }
        } else {
          // Single file
          const rawContent = await readFile(resolved, "utf-8");
          const detected = detectFormatFromExtension(args.path);
          const memories = parseContent(rawContent, {
            format: format ?? detected ?? undefined,
            filename: args.path,
          });
          for (const mem of memories) {
            allMemories.push({
              content: mem.content,
              ...(mem.id ? { id: mem.id } : {}),
              ...(mem.meta ? { meta: mem.meta } : {}),
              ...(mem.tree ? { tree: mem.tree } : {}),
              ...(mem.temporal ? { temporal: mem.temporal } : {}),
            });
          }
        }
      } else if (args.content) {
        const memories = parseContent(args.content, { format });
        for (const mem of memories) {
          allMemories.push({
            content: mem.content,
            ...(mem.id ? { id: mem.id } : {}),
            ...(mem.meta ? { meta: mem.meta } : {}),
            ...(mem.tree ? { tree: mem.tree } : {}),
            ...(mem.temporal ? { temporal: mem.temporal } : {}),
          });
        }
      } else {
        throw new Error("Either path or content is required.");
      }

      const result = await requireClient(session).memory.batchCreate({
        memories: allMemories,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { imported: result.ids.length, ids: result.ids },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // me_memory_export
  server.registerTool(
    "me_memory_export",
    {
      title: "Export Memories",
      description: `Bulk export memories with filters. Returns formatted content as a string, or writes to a file.

Token-efficient: use \`path\` to write directly to a file instead of returning content through the conversation.

Docs: ${docUrl("me_memory_export")}`,
      inputSchema: {
        tree: z
          .string()
          .optional()
          .nullable()
          .describe("Tree path filter (omit or null for all)"),
        meta: z
          .record(z.string(), z.any())
          .optional()
          .nullable()
          .describe("Metadata filter"),
        temporal: z
          .object({
            contains: z
              .string()
              .optional()
              .nullable()
              .describe("Find memories containing this point in time"),
            overlaps: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .optional()
              .nullable()
              .describe("Find memories overlapping this range"),
            within: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .optional()
              .nullable()
              .describe("Find memories fully within this range"),
          })
          .optional()
          .nullable()
          .describe("Temporal filter"),
        format: z.string().describe("Output format: json, yaml, or md"),
        limit: z
          .number()
          .int()
          .optional()
          .nullable()
          .describe(
            "Maximum memories to export (omit or null for default 1000)",
          ),
        path: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Absolute file or directory path to write to. For md format, use a directory path to write one .md file per memory. Omit or null to return content inline.",
          ),
      },
      annotations: {
        title: "Export Memories",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const searchParams: Record<string, unknown> = {
        limit: args.limit && args.limit > 0 ? args.limit : 1000,
        orderBy: "asc",
      };
      if (args.tree) searchParams.tree = args.tree;
      if (args.meta) searchParams.meta = args.meta;
      if (args.temporal) {
        searchParams.temporal = {
          contains: args.temporal.contains ?? undefined,
          overlaps: args.temporal.overlaps ?? undefined,
          within: args.temporal.within ?? undefined,
        };
      }

      const result = await requireClient(session).memory.search(
        searchParams as Parameters<EngineClient["memory"]["search"]>[0],
      );

      // Strip to import-compatible fields
      const memories = result.results.map((r: Record<string, unknown>) => ({
        id: r.id,
        content: r.content,
        ...((r.meta as Record<string, unknown> | undefined) &&
        Object.keys(r.meta as Record<string, unknown>).length > 0
          ? { meta: r.meta }
          : {}),
        ...(r.tree ? { tree: r.tree } : {}),
        ...(r.temporal ? { temporal: r.temporal } : {}),
      }));

      const format = args.format as "json" | "yaml" | "md";

      // Markdown with directory path: write one .md file per memory
      if (format === "md" && args.path) {
        const resolved = resolve(args.path);
        if (!existsSync(resolved)) {
          mkdirSync(resolved, { recursive: true });
        }
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          for (const mem of memories) {
            const filename = `${mem.id}.md`;
            const filepath = join(resolved, filename);
            writeFileSync(filepath, formatMemoryAsMarkdown(mem), "utf-8");
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { count: memories.length, directory: args.path },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        // path exists but is a file — write single memory
        if (memories.length > 1) {
          throw new Error(
            `Cannot write ${memories.length} memories to a single Markdown file. Specify a directory path for multi-memory Markdown export.`,
          );
        }
        if (memories.length === 1 && memories[0]) {
          await Bun.write(args.path, formatMemoryAsMarkdown(memories[0]));
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: memories.length, path: args.path },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Markdown inline: only allowed for single memory
      if (format === "md" && !args.path) {
        if (memories.length > 1) {
          throw new Error(
            `Cannot return ${memories.length} memories as inline Markdown. Specify a directory path for multi-memory Markdown export.`,
          );
        }
        const content =
          memories.length === 1 && memories[0]
            ? formatMemoryAsMarkdown(memories[0])
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: memories.length, content },
                null,
                2,
              ),
            },
          ],
        };
      }

      // JSON / YAML
      let content: string;
      if (format === "yaml") {
        content = yamlStringify(memories, { lineWidth: 0 });
      } else {
        content = JSON.stringify(memories, null, 2);
      }

      if (args.path) {
        await Bun.write(args.path, content);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: memories.length, path: args.path },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: memories.length, content }, null, 2),
          },
        ],
      };
    },
  );

  // me_session_get_engine
  server.registerTool(
    "me_session_get_engine",
    {
      title: "Show Active Engine",
      description: `Return which Memory Engine this MCP session is currently bound to. Read-only; never exposes the API key.

Returns { bound: false } if the session has not yet been bound to any engine via me_session_use_engine. Useful before destructive writes to confirm the target engine.

Docs: ${docUrl("me_session_get_engine")}`,
      inputSchema: {},
      annotations: {
        title: "Show Active Engine",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            session.activeEngine
              ? { bound: true, engine: session.activeEngine }
              : { bound: false },
            null,
            2,
          ),
        },
      ],
    }),
  );

  // me_session_use_engine
  server.registerTool(
    "me_session_use_engine",
    {
      title: "Switch Active Engine",
      description: `Bind this MCP session to a specific Memory Engine. All subsequent me_memory_* tool calls in this session will read from and write to the chosen engine.

Per-session, in-memory only. Does NOT modify ~/.config/me/credentials.yaml or affect other Claude Code sessions or other MCP clients. Switching back to a previously-used engine is free; the API key is cached for the lifetime of this MCP process.

Use this when you want to scope memory writes to a team-shared engine (e.g. an investigation knowledge base) without polluting a personal default engine.

Errors if no local API key exists for the target engine. Call me_session_provision_engine first to mint one.

Docs: ${docUrl("me_session_use_engine")}`,
      inputSchema: {
        engine: z
          .string()
          .min(1)
          .describe(
            "Engine slug, name, or ID. Combine with org for disambiguation (e.g. an engine named 'oncall' that exists in two orgs).",
          ),
        org: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Optional org disambiguator: org slug, name, or ID. Omit unless engine is ambiguous.",
          ),
        validate: z
          .boolean()
          .optional()
          .nullable()
          .describe(
            "If true (default), round-trip a cheap call to verify the stored key works before committing the switch.",
          ),
      },
      annotations: {
        title: "Switch Active Engine",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const accounts = requireAccountsClient(session);
      const all = await fetchAllEngines(accounts);
      const target = resolveEngineForSession(
        all,
        args.engine,
        args.org ?? undefined,
      );

      const key = getEngineApiKey(session.server, target.slug);
      if (!key) {
        throw new Error(
          `No local API key for engine '${target.slug}'. ` +
            `Call me_session_provision_engine with engine='${target.slug}' to mint one, then retry.`,
        );
      }

      const cached = session.clients.get(target.slug);
      const validate = args.validate !== false && !cached;
      if (validate) {
        const probe = createClient({ url: session.server, apiKey: key });
        await probe.memory.tree({ levels: 1 });
        session.clients.set(target.slug, probe);
      } else if (!cached) {
        session.clients.set(
          target.slug,
          createClient({ url: session.server, apiKey: key }),
        );
      }

      const previous = session.activeEngine?.slug ?? null;
      session.activeEngine = {
        slug: target.slug,
        name: target.name,
        orgSlug: target.orgSlug,
        orgName: target.orgName,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                engine: {
                  id: target.id,
                  slug: target.slug,
                  name: target.name,
                  org: { slug: target.orgSlug, name: target.orgName },
                },
                previous_engine: previous,
                validated: validate,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // me_session_provision_engine
  server.registerTool(
    "me_session_provision_engine",
    {
      title: "Provision Engine API Key",
      description: `Mint a fresh API key for a Memory Engine on the active server, persist it to ~/.config/me/credentials.yaml under engines.<slug>.api_key, and bind this MCP session to that engine. Use this when me_session_use_engine errors with "No local API key for engine '<slug>'".

Uses the session token from credentials.yaml (so the user must have run \`me login\` previously). Calls accounts.engine.setupAccess on the server, which authorizes the current user against the engine and returns a raw key.

Idempotent: if a key already exists for the target engine, no setupAccess call is made; the session is bound using the existing key. Does NOT change credentials.yaml's active_engine; this tool only adds keys, it never silently changes which engine the next CLI process treats as default.

Docs: ${docUrl("me_session_provision_engine")}`,
      inputSchema: {
        engine: z
          .string()
          .min(1)
          .describe("Engine slug, name, or ID to provision."),
        org: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Optional org disambiguator: org slug, name, or ID. Omit unless engine is ambiguous.",
          ),
      },
      annotations: {
        title: "Provision Engine API Key",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const accounts = requireAccountsClient(session);
      const all = await fetchAllEngines(accounts);
      const target = resolveEngineForSession(
        all,
        args.engine,
        args.org ?? undefined,
      );

      const existingKey = getEngineApiKey(session.server, target.slug);
      let provisioned = false;
      let apiKey: string;
      if (existingKey) {
        apiKey = existingKey;
      } else {
        const result = await accounts.engine.setupAccess({
          engineId: target.id,
        });
        addEngineApiKey(session.server, result.engineSlug, result.rawKey);
        apiKey = result.rawKey;
        provisioned = true;
      }

      if (!session.clients.has(target.slug)) {
        session.clients.set(
          target.slug,
          createClient({ url: session.server, apiKey }),
        );
      }

      const previous = session.activeEngine?.slug ?? null;
      session.activeEngine = {
        slug: target.slug,
        name: target.name,
        orgSlug: target.orgSlug,
        orgName: target.orgName,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                engine: {
                  id: target.id,
                  slug: target.slug,
                  name: target.name,
                  org: { slug: target.orgSlug, name: target.orgName },
                },
                previous_engine: previous,
                provisioned,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // me_engine_list
  server.registerTool(
    "me_engine_list",
    {
      title: "List Engines",
      description: `List engines this identity has access to across all orgs. Read-only. Uses the session token from credentials.yaml, not the active engine's API key, so it works regardless of which engine is currently bound (or even when none is bound).

Use as the first step of an engine-switching flow: enumerate, then call me_session_use_engine with the chosen slug.

Docs: ${docUrl("me_engine_list")}`,
      inputSchema: {
        filter: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Substring filter on engine name or slug (case-insensitive). Useful when the user typed a partial name.",
          ),
        org: z
          .string()
          .optional()
          .nullable()
          .describe("Restrict to a single org by slug, name, or ID."),
        has_local_key: z
          .boolean()
          .optional()
          .nullable()
          .describe(
            "If true, only return engines for which a local API key is already stored (i.e. ready to bind without provisioning).",
          ),
      },
      annotations: {
        title: "List Engines",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const accounts = requireAccountsClient(session);
      const engines = await fetchAllEngines(accounts);

      const filter = args.filter?.toLowerCase();
      const org = args.org ?? undefined;
      const onlyLocal = args.has_local_key === true;
      // Read credentials.yaml once instead of N times (one per engine).
      const localKeys = getServerCredentials(session.server).engines ?? {};
      const activeSlug = session.activeEngine?.slug;

      const filtered = engines
        .filter((e) => (org ? inOrg(e, org) : true))
        .filter((e) =>
          filter
            ? e.slug.toLowerCase().includes(filter) ||
              e.name.toLowerCase().includes(filter)
            : true,
        )
        .map((e) => ({
          id: e.id,
          slug: e.slug,
          name: e.name,
          status: e.status,
          org: { slug: e.orgSlug, name: e.orgName, id: e.orgId },
          has_local_key: Boolean(localKeys[e.slug]?.api_key),
          active: activeSlug === e.slug,
        }))
        .filter((e) => (onlyLocal ? e.has_local_key : true));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ engines: filtered }, null, 2),
          },
        ],
      };
    },
  );
}

// =============================================================================
// Shutdown
// =============================================================================

function setupShutdownHandlers(mcpServer: McpServer): void {
  let shutdownRequested = false;

  const shutdown = async () => {
    if (shutdownRequested) return;
    shutdownRequested = true;

    console.error("\nShutting down MCP server...");
    try {
      await mcpServer.close();
      console.error("Shutdown complete");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// =============================================================================
// Entry Point
// =============================================================================

export interface McpServerOptions {
  apiKey?: string;
  server: string;
  sessionToken?: string;
}

/**
 * Run MCP server over stdio.
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const session: McpSession = {
    server: options.server,
    sessionToken: options.sessionToken,
    activeEngine: null,
    clients: new Map(),
  };

  // Bootstrap path keeps the existing Claude Code plugin's .mcp.json working
  // unchanged: --api-key seeds the session as already bound. name/org fill in
  // later if the agent calls me_session_use_engine.
  if (options.apiKey) {
    const slug = parseEngineSlugFromKey(options.apiKey);
    if (slug) {
      session.activeEngine = { slug };
      session.clients.set(
        slug,
        createClient({ url: options.server, apiKey: options.apiKey }),
      );
    } else {
      console.error(
        "Warning: --api-key did not match the expected `me.<slug>.<id>.<secret>` shape; ignoring.",
      );
    }
  }

  const mcpServer = new McpServer(
    {
      name: "me",
      version: CLIENT_VERSION,
    },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );

  registerTools(mcpServer, session);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  setupShutdownHandlers(mcpServer);

  // Keep process alive — stdio transport handles I/O
  console.error("MCP server running on stdio");
}
