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
import { batchCreateChunked } from "../chunk.ts";
import type { EngineClient } from "../client.ts";
import { createClient } from "../client.ts";
import { formatMemoryAsMarkdown } from "../commands/memory.ts";
import {
  detectFormatFromExtension,
  type ImportFormat,
  parseContent,
} from "../parsers/index.ts";

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
// Tool Registration
// =============================================================================

function registerTools(server: McpServer, client: EngineClient): void {
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
      const result = await client.memory.create({
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
      const result = await client.memory.search({
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
      const result = await client.memory.get({ id: args.id });
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
      const result = await client.memory.update({
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
      const result = await client.memory.delete({ id: args.id });
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
      const result = await client.memory.deleteTree({
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
      const result = await client.memory.move({
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
      const result = await client.memory.tree({
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
        // Server-side `ON CONFLICT (id) DO NOTHING` makes repeat calls with
        // the same explicit ids land the engine in the same state. With
        // chunking, a partial-failure call can be retried safely: ids
        // already inserted are skipped, ids in failed chunks are
        // re-attempted, and the final state converges to "all submitted
        // ids present" once at least one call gets each chunk through.
        idempotentHint: true,
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

      const explicitIds = allMemories
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");

      // Chunked batch create — large imports are sliced under the
      // server's request-body limit, and a single failed chunk doesn't
      // take down the rest of the import.
      const { insertedIds, failedIds, errors } = await batchCreateChunked(
        client,
        allMemories,
      );

      // Throw only on total failure — the agent should see partial-success
      // detail rather than an opaque error for mixed outcomes.
      if (insertedIds.length === 0 && errors.length > 0) {
        throw new Error(
          errors.length === 1
            ? errors[0]?.error
            : `All ${errors.length} chunks failed; first error: ${errors[0]?.error}`,
        );
      }

      // Server-side `ON CONFLICT (id) DO NOTHING` may silently drop
      // duplicate ids; surface those so the caller can investigate.
      // Failed-chunk ids never reached the server, so they're not
      // skipped — they're reported separately under `failed`/`errors`.
      const insertedSet = new Set(insertedIds);
      const failedSet = new Set(failedIds);
      const skippedIds = explicitIds.filter(
        (id) => !insertedSet.has(id) && !failedSet.has(id),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                imported: insertedIds.length,
                skipped: skippedIds.length,
                failed: failedIds.length,
                ids: insertedIds,
                skippedIds,
                errors,
              },
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

      const result = await client.memory.search(
        searchParams as Parameters<typeof client.memory.search>[0],
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
  apiKey: string;
  server: string;
}

/**
 * Run MCP server over stdio.
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const client = createClient({ url: options.server, apiKey: options.apiKey });

  const mcpServer = new McpServer(
    {
      name: "me",
      version: CLIENT_VERSION,
    },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );

  registerTools(mcpServer, client);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  setupShutdownHandlers(mcpServer);

  // Keep process alive — stdio transport handles I/O
  console.error("MCP server running on stdio");
}
