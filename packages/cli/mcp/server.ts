/**
 * MCP Server — stdio-based Model Context Protocol server.
 *
 * A thin proxy: translates MCP tool calls into engine client HTTP calls.
 * Each instance is locked to a single engine via its API key.
 */

import type { EngineClient } from "@memory-engine/client";
import { createClient } from "@memory-engine/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { APP_VERSION } from "../../../version";
import {
  detectFormatFromExtension,
  type ImportFormat,
  parseContent,
} from "../parsers/index.ts";

const DOCS_BASE = `https://raw.githubusercontent.com/timescale/memory-engine/v${APP_VERSION}/docs/mcp`;

/** URL to a tool's documentation on GitHub. */
function docUrl(tool: string): string {
  return `${DOCS_BASE}/${tool}.md`;
}

/**
 * MCP instructions — sent to the client during initialization.
 */
const MCP_INSTRUCTIONS = `memory engine — permanent memory for AI agents. Store, search, and organize knowledge across conversations.

Tool docs: ${DOCS_BASE}`;

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
          .nullable()
          .describe("UUIDv7 for idempotent creates (null to auto-generate)"),
        content: z.string().min(1).describe("The content of the memory"),
        meta: z
          .record(z.string(), z.any())
          .nullable()
          .describe("Key-value metadata pairs (null to omit)"),
        tree: z
          .string()
          .nullable()
          .describe(
            "Hierarchical path (e.g., work.projects.me). Null defaults to root",
          ),
        temporal: z
          .object({
            start: z.string().describe("ISO timestamp for start of time range"),
            end: z
              .string()
              .nullable()
              .describe("ISO timestamp for end (null for point-in-time)"),
          })
          .nullable()
          .describe("Time range for the memory (null to omit)"),
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
        temporal: args.temporal ?? undefined,
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

Search modes: semantic (meaning), fulltext (keywords), or both (hybrid). Combine with tree, meta, and temporal filters. Results scored 0-1.

Docs: ${docUrl("me_memory_search")}`,
      inputSchema: {
        semantic: z
          .string()
          .nullable()
          .describe("Natural language query for semantic/meaning search"),
        fulltext: z
          .string()
          .nullable()
          .describe("Keywords/phrases for BM25 exact matching"),
        grep: z
          .string()
          .nullable()
          .describe(
            "Regex pattern filter on content (POSIX, case-insensitive). Applied as WHERE filter alongside other filters.",
          ),
        meta: z
          .record(z.string(), z.any())
          .nullable()
          .describe("Filter by metadata attributes (null to omit)"),
        tree: z
          .string()
          .nullable()
          .describe(
            "Filter by tree path. Bare path (work.projects) matches exactly \u2014 use work.projects.* to include descendants. Supports lquery patterns (*.api.*) and ltxtquery label search (api & v2).",
          ),
        temporal: z
          .object({
            contains: z
              .string()
              .nullable()
              .describe("Find memories containing this point in time"),
            overlaps: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .nullable()
              .describe("Find memories overlapping this range"),
            within: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .nullable()
              .describe("Find memories fully within this range"),
          })
          .nullable()
          .describe("Temporal filter for search (null to omit)"),
        weights: z
          .object({
            fulltext: z
              .number()
              .nullable()
              .describe("Weight for BM25 keyword matching (0-1)"),
            semantic: z
              .number()
              .nullable()
              .describe("Weight for semantic similarity (0-1)"),
          })
          .nullable()
          .describe("Weights for hybrid search ranking (null to omit)"),
        candidateLimit: z
          .number()
          .int()
          .describe(
            "Candidates per search mode before RRF fusion (0 = default 30)",
          ),
        limit: z
          .number()
          .int()
          .describe("Maximum results (0 = default 10, max: 1000)"),
        order_by: z
          .string()
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
          args.candidateLimit > 0 ? args.candidateLimit : undefined,
        limit: args.limit > 0 ? args.limit : undefined,
        orderBy: (args.order_by as "asc" | "desc") ?? undefined,
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
          .nullable()
          .describe("New content (null to keep existing)"),
        meta: z
          .record(z.string(), z.any())
          .nullable()
          .describe("New metadata (null to keep existing)"),
        tree: z
          .string()
          .nullable()
          .describe("New tree path (null to keep existing)"),
        temporal: z
          .object({
            start: z.string().describe("ISO timestamp for start of time range"),
            end: z
              .string()
              .nullable()
              .describe("ISO timestamp for end (null for point-in-time)"),
          })
          .nullable()
          .describe("Time range for the memory (null to omit)"),
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
        temporal: args.temporal ?? undefined,
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
          .nullable()
          .describe(
            "Root path to display from (e.g., work.projects). Null for full tree",
          ),
        levels: z
          .number()
          .int()
          .describe("Maximum depth to display (0 = unlimited)"),
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
        levels: args.levels > 0 ? args.levels : undefined,
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
      description: `Bulk import memories from a file or content string. Parses the content according to the specified format and creates all memories in one batch.

Token-efficient: prefer \`path\` over \`content\` to avoid passing large payloads through the conversation.

Docs: ${docUrl("me_memory_import")}`,
      inputSchema: {
        path: z
          .string()
          .nullable()
          .describe(
            "Absolute file path to import from. Format is inferred from extension (.json, .yaml, .yml, .md). Mutually exclusive with content.",
          ),
        content: z
          .string()
          .nullable()
          .describe(
            "Raw content to import (JSON array, YAML array, or Markdown with frontmatter). Mutually exclusive with path.",
          ),
        format: z
          .string()
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
      let rawContent: string;
      let format: ImportFormat | undefined;

      if (args.path) {
        const file = Bun.file(args.path);
        if (!(await file.exists())) {
          throw new Error(`File not found: ${args.path}`);
        }
        rawContent = await file.text();
        const detected = detectFormatFromExtension(args.path);
        format = (args.format as ImportFormat) ?? detected ?? undefined;
      } else if (args.content) {
        rawContent = args.content;
        format = (args.format as ImportFormat) ?? undefined;
      } else {
        throw new Error("Either path or content is required.");
      }

      const memories = parseContent(rawContent, {
        format,
        filename: args.path ?? undefined,
      });

      const createParams = memories.map((mem) => ({
        content: mem.content,
        ...(mem.id ? { id: mem.id } : {}),
        ...(mem.meta ? { meta: mem.meta } : {}),
        ...(mem.tree ? { tree: mem.tree } : {}),
        ...(mem.temporal ? { temporal: mem.temporal } : {}),
      }));

      const result = await client.memory.batchCreate({
        memories: createParams,
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
        tree: z.string().nullable().describe("Tree path filter (null for all)"),
        meta: z
          .record(z.string(), z.any())
          .nullable()
          .describe("Metadata filter (null to omit)"),
        temporal: z
          .object({
            contains: z
              .string()
              .nullable()
              .describe("Find memories containing this point in time"),
            overlaps: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .nullable()
              .describe("Find memories overlapping this range"),
            within: z
              .object({
                start: z.string().describe("Start of range"),
                end: z.string().describe("End of range"),
              })
              .nullable()
              .describe("Find memories fully within this range"),
          })
          .nullable()
          .describe("Temporal filter (null to omit)"),
        format: z.string().describe("Output format: json, yaml, or md"),
        limit: z
          .number()
          .int()
          .describe("Maximum memories to export (0 = default 1000)"),
        path: z
          .string()
          .nullable()
          .describe(
            "Absolute file path to write to. If provided, content is written to the file and not returned inline. Null to return content inline.",
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
        limit: args.limit > 0 ? args.limit : 1000,
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

      let content: string;
      const format = args.format as "json" | "yaml" | "md";

      if (format === "yaml") {
        content = yamlStringify(memories, { lineWidth: 0 });
      } else if (format === "md") {
        content = memories
          .map((mem: Record<string, unknown>) => {
            const fm: Record<string, unknown> = { id: mem.id };
            if (mem.meta) fm.meta = mem.meta;
            if (mem.tree) fm.tree = mem.tree;
            if (mem.temporal) fm.temporal = mem.temporal;
            const yaml = yamlStringify(fm, { lineWidth: 0 }).trimEnd();
            return `---\n${yaml}\n---\n\n${mem.content}\n`;
          })
          .join("\n");
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
      version: APP_VERSION,
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
