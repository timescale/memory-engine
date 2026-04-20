/**
 * me memory — memory management commands.
 *
 * - me memory create [content]: Create a memory
 * - me memory get <id>: Get a memory by ID
 * - me memory view <id>: View a memory rendered in the terminal
 * - me memory search [query]: Hybrid search
 * - me memory update <id>: Update a memory
 * - me memory delete <id-or-tree>: Delete memory or tree
 * - me memory edit <id>: Open in $EDITOR
 * - me memory tree [filter]: Show tree structure
 * - me memory move <src> <dst>: Move memories between tree paths
 * - me memory import [files...]: Import from files/stdin
 * - me memory export [file]: Export with filters
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { createClient } from "@memory.build/client";
import { Command } from "commander";
import { stringify as yamlStringify } from "yaml";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";
import { editMemory } from "./memory-edit.ts";
import { createMemoryImportCommand } from "./memory-import.ts";
import { renderTree } from "./memory-tree.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Parse a --meta flag value (JSON string) to an object.
 */
function parseMeta(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --meta: ${msg}`);
  }
}

/**
 * Parse a --temporal flag value (start[,end]) to a temporal object.
 */
function parseTemporal(value: string): { start: string; end?: string | null } {
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length === 1 && parts[0]) {
    return { start: parts[0] };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { start: parts[0], end: parts[1] };
  }
  throw new Error(
    "Invalid --temporal: expected 'start' or 'start,end' (ISO 8601)",
  );
}

/**
 * Format a memory for Markdown output (frontmatter + content).
 */
export function formatMemoryAsMarkdown(
  memory: Record<string, unknown>,
): string {
  const frontmatter: Record<string, unknown> = { id: memory.id };
  if (memory.createdAt) frontmatter.created_at = memory.createdAt;
  if (
    memory.meta &&
    typeof memory.meta === "object" &&
    Object.keys(memory.meta as object).length > 0
  ) {
    frontmatter.meta = memory.meta;
  }
  if (memory.tree) frontmatter.tree = memory.tree;
  if (memory.temporal) frontmatter.temporal = memory.temporal;

  const yaml = yamlStringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${memory.content}\n`;
}

// =============================================================================
// Commands
// =============================================================================

function createMemoryCreateCommand(): Command {
  return new Command("create")
    .description("create a memory")
    .argument("[content]", "memory content")
    .option("--content <text>", "memory content (alternative to positional)")
    .option("--tree <path>", "tree path")
    .option("--meta <json>", "metadata as JSON")
    .option("--temporal <range>", "temporal range (start[,end])")
    .action(async (positionalContent: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      // Resolve content: positional > --content flag > stdin
      let content = positionalContent ?? opts.content;
      if (!content) {
        // Try stdin
        const isTTY = process.stdin.isTTY;
        if (!isTTY) {
          content = await Bun.stdin.text();
          content = content.trimEnd();
        }
      }
      if (!content) {
        if (fmt === "text") {
          clack.log.error(
            "No content provided. Pass as argument, --content flag, or pipe from stdin.",
          );
        } else {
          output({ error: "No content provided" }, fmt, () => {});
        }
        process.exit(1);
      }

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const params: Record<string, unknown> = { content };
        if (opts.tree) params.tree = opts.tree;
        if (opts.meta) params.meta = parseMeta(opts.meta);
        if (opts.temporal) params.temporal = parseTemporal(opts.temporal);

        const memory = await engine.memory.create(
          params as Parameters<typeof engine.memory.create>[0],
        );

        output(memory, fmt, () => {
          clack.log.success(`Created memory ${memory.id}`);
          if (memory.tree) console.log(`  Tree: ${memory.tree}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryGetCommand(): Command {
  return new Command("get")
    .description("get a memory by ID")
    .argument("<id>", "memory ID")
    .option("--md", "output as Markdown with YAML frontmatter")
    .action(async (id: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const memory = await engine.memory.get({ id });

        if (opts.md) {
          console.log(
            formatMemoryAsMarkdown(
              memory as unknown as Record<string, unknown>,
            ),
          );
          return;
        }

        output(memory, fmt, () => {
          console.log(`  ID:        ${memory.id}`);
          console.log(`  Content:   ${memory.content}`);
          console.log(`  Tree:      ${memory.tree || "(none)"}`);
          console.log(
            `  Meta:      ${memory.meta && Object.keys(memory.meta).length > 0 ? JSON.stringify(memory.meta) : "(none)"}`,
          );
          console.log(
            `  Temporal:  ${memory.temporal ? `${memory.temporal.start} → ${memory.temporal.end ?? "∞"}` : "(none)"}`,
          );
          console.log(
            `  Embedding: ${memory.hasEmbedding ? "yes" : "pending"}`,
          );
          console.log(`  Created:   ${memory.createdAt}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemorySearchCommand(): Command {
  return new Command("search")
    .description("search memories")
    .argument("[query]", "semantic search query (shorthand for --semantic)")
    .option("--semantic <text>", "semantic (vector) search")
    .option("--fulltext <text>", "BM25 keyword search")
    .option(
      "--grep <pattern>",
      "regex filter on content (POSIX, case-insensitive)",
    )
    .option("--tree <filter>", "tree path filter (supports wildcards)")
    .option("--meta <json>", "metadata filter (JSON)")
    .option("--limit <n>", "max results", "10")
    .option("--candidate-limit <n>", "pre-RRF candidate pool size")
    .option("--temporal-contains <ts>", "memory must contain this point")
    .option("--temporal-overlaps <range>", "memory must overlap (start,end)")
    .option("--temporal-within <range>", "memory must be within (start,end)")
    .option("--weight-semantic <w>", "semantic weight (0-1)")
    .option("--weight-fulltext <w>", "fulltext weight (0-1)")
    .option("--order-by <dir>", "sort direction (asc|desc)")
    .action(async (query: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      // Resolve semantic query
      const semantic = query ?? opts.semantic ?? null;
      if (query && opts.semantic) {
        if (fmt === "text") {
          clack.log.error(
            "Cannot use both positional query and --semantic flag.",
          );
        } else {
          output(
            { error: "Cannot use both positional query and --semantic" },
            fmt,
            () => {},
          );
        }
        process.exit(1);
      }

      const fulltext = opts.fulltext ?? null;
      const tree = opts.tree ?? null;
      const meta = opts.meta ? parseMeta(opts.meta) : null;

      // Validate at least one search criterion
      if (
        !semantic &&
        !fulltext &&
        !opts.grep &&
        !tree &&
        !meta &&
        !opts.temporalContains &&
        !opts.temporalOverlaps &&
        !opts.temporalWithin
      ) {
        const msg =
          "At least one search criterion required (query, --semantic, --fulltext, --grep, --tree, --meta, or --temporal-*).";
        if (fmt === "text") {
          clack.log.error(msg);
        } else {
          output({ error: msg }, fmt, () => {});
        }
        process.exit(1);
      }

      // Build temporal filter
      let temporal: Record<string, unknown> | null = null;
      if (opts.temporalContains) {
        temporal = { contains: opts.temporalContains };
      } else if (opts.temporalOverlaps) {
        const parts = opts.temporalOverlaps
          .split(",")
          .map((s: string) => s.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          handleError(new Error("--temporal-overlaps requires start,end"), fmt);
        }
        temporal = { overlaps: { start: parts[0], end: parts[1] } };
      } else if (opts.temporalWithin) {
        const parts = opts.temporalWithin
          .split(",")
          .map((s: string) => s.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          handleError(new Error("--temporal-within requires start,end"), fmt);
        }
        temporal = { within: { start: parts[0], end: parts[1] } };
      }

      // Build weights (only when both semantic + fulltext)
      let weights: Record<string, number> | null = null;
      if (opts.weightSemantic || opts.weightFulltext) {
        weights = {};
        if (opts.weightSemantic)
          weights.semantic = Number.parseFloat(opts.weightSemantic);
        if (opts.weightFulltext)
          weights.fulltext = Number.parseFloat(opts.weightFulltext);
      }

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const params: Record<string, unknown> = {
          limit: Number.parseInt(opts.limit, 10),
        };
        if (semantic) params.semantic = semantic;
        if (fulltext) params.fulltext = fulltext;
        if (opts.grep) params.grep = opts.grep;
        if (tree) params.tree = tree;
        if (meta) params.meta = meta;
        if (temporal) params.temporal = temporal;
        if (weights) params.weights = weights;
        if (opts.candidateLimit)
          params.candidateLimit = Number.parseInt(opts.candidateLimit, 10);
        if (opts.orderBy) params.orderBy = opts.orderBy;

        const result = await engine.memory.search(
          params as Parameters<typeof engine.memory.search>[0],
        );

        output(result, fmt, () => {
          console.log(
            `Found ${result.total} results (showing ${result.results.length})`,
          );
          if (result.results.length === 0) return;
          console.log();
          table(
            ["id", "content", "tree", "score"],
            result.results.map((r) => {
              const preview =
                r.content.length > 60
                  ? `${r.content.slice(0, 60)}...`
                  : r.content;
              return [
                r.id,
                preview,
                r.tree ?? "",
                r.score < 1.0 ? r.score.toFixed(3) : "",
              ];
            }),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryUpdateCommand(): Command {
  return new Command("update")
    .description("update a memory")
    .argument("<id>", "memory ID")
    .option("--content <text>", "new content (use - for stdin)")
    .option("--tree <path>", "new tree path")
    .option("--meta <json>", "new metadata (replaces existing)")
    .option("--temporal <range>", "new temporal range (start[,end])")
    .action(async (id: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      // Resolve content
      let content = opts.content;
      if (content === "-") {
        content = (await Bun.stdin.text()).trimEnd();
      }

      if (!content && !opts.tree && !opts.meta && !opts.temporal) {
        const msg =
          "At least one update field required (--content, --tree, --meta, or --temporal).";
        if (fmt === "text") {
          clack.log.error(msg);
        } else {
          output({ error: msg }, fmt, () => {});
        }
        process.exit(1);
      }

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const params: Record<string, unknown> = { id };
        if (content) params.content = content;
        if (opts.tree) params.tree = opts.tree;
        if (opts.meta) params.meta = parseMeta(opts.meta);
        if (opts.temporal) params.temporal = parseTemporal(opts.temporal);

        const memory = await engine.memory.update(
          params as Parameters<typeof engine.memory.update>[0],
        );

        output(memory, fmt, () => {
          clack.log.success(`Updated memory ${memory.id}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description("delete a memory by ID, or all memories under a tree path")
    .argument("<id-or-tree>", "memory ID (UUIDv7) or tree path")
    .option("--dry-run", "preview what would be deleted (tree mode)")
    .option("-y, --yes", "skip confirmation (tree mode)")
    .action(async (idOrTree: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        if (UUIDV7_RE.test(idOrTree)) {
          // Single memory delete
          const result = await engine.memory.delete({ id: idOrTree });
          output(result, fmt, () => {
            if (result.deleted) {
              clack.log.success(`Deleted memory ${idOrTree}`);
            } else {
              clack.log.warn("Memory not found.");
            }
          });
        } else {
          // Tree delete — always dry-run first
          const preview = await engine.memory.deleteTree({
            tree: idOrTree,
            dryRun: true,
          });

          if (preview.count === 0) {
            output({ count: 0 }, fmt, () => {
              clack.log.warn(`No memories found under '${idOrTree}'`);
            });
            return;
          }

          if (fmt === "text") {
            console.log(
              `  ${preview.count} ${preview.count === 1 ? "memory" : "memories"} will be deleted under '${idOrTree}'`,
            );
          }

          if (opts.dryRun) {
            output({ dryRun: true, count: preview.count }, fmt, () => {});
            return;
          }

          // Confirm unless --yes
          if (fmt === "text" && !opts.yes) {
            const confirmed = await clack.confirm({
              message: `Delete ${preview.count} ${preview.count === 1 ? "memory" : "memories"}?`,
              initialValue: false,
            });
            if (clack.isCancel(confirmed) || !confirmed) {
              clack.cancel("Cancelled.");
              process.exit(0);
            }
          }

          const result = await engine.memory.deleteTree({
            tree: idOrTree,
            dryRun: false,
          });
          output(result, fmt, () => {
            clack.log.success(
              `Deleted ${result.count} ${result.count === 1 ? "memory" : "memories"}`,
            );
          });
        }
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryEditCommand(): Command {
  return new Command("edit")
    .description("open a memory in your editor")
    .argument("<id>", "memory ID")
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        await editMemory(engine, id);
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryTreeCommand(): Command {
  return new Command("tree")
    .description("show memory tree structure")
    .argument("[filter]", "root tree path to start from")
    .option("--levels <n>", "max depth to display")
    .action(async (filter: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const params: Record<string, unknown> = {};
        if (filter) params.tree = filter;
        if (opts.levels) params.levels = Number.parseInt(opts.levels, 10);

        const result = await engine.memory.tree(
          params as Parameters<typeof engine.memory.tree>[0],
        );

        output(result, fmt, () => {
          // Calculate total from nodes
          const total =
            result.nodes.length > 0
              ? result.nodes.reduce(
                  (max: number, n: { count: number }) =>
                    n.count > max ? n.count : max,
                  0,
                )
              : 0;
          console.log(renderTree(result.nodes, total, filter));
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryMoveCommand(): Command {
  return new Command("move")
    .alias("mv")
    .description("move memories between tree paths")
    .argument("<src>", "source tree path")
    .argument("<dst>", "destination tree path")
    .option("--dry-run", "preview what would be moved")
    .option("-y, --yes", "skip confirmation")
    .action(async (src: string, dst: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        // Always dry-run first to show preview
        const preview = await engine.memory.move({
          source: src,
          destination: dst,
          dryRun: true,
        });

        if (preview.count === 0) {
          output({ count: 0 }, fmt, () => {
            clack.log.warn(`No memories found under '${src}'`);
          });
          return;
        }

        if (fmt === "text") {
          console.log(
            `  ${preview.count} ${preview.count === 1 ? "memory" : "memories"} will be moved from '${src}' to '${dst}'`,
          );
        }

        if (opts.dryRun) {
          output({ dryRun: true, count: preview.count }, fmt, () => {});
          return;
        }

        // Confirm unless --yes
        if (fmt === "text" && !opts.yes) {
          const confirmed = await clack.confirm({
            message: `Move ${preview.count} ${preview.count === 1 ? "memory" : "memories"}?`,
            initialValue: false,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }

        const result = await engine.memory.move({
          source: src,
          destination: dst,
        });

        output(result, fmt, () => {
          clack.log.success(
            `Moved ${result.count} ${result.count === 1 ? "memory" : "memories"} from '${src}' to '${dst}'`,
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

/**
 * Strip a memory response to import-compatible fields only.
 */
function toExportable(
  memory: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: memory.id,
    content: memory.content,
  };
  if (
    memory.meta &&
    typeof memory.meta === "object" &&
    Object.keys(memory.meta as object).length > 0
  ) {
    result.meta = memory.meta;
  }
  if (memory.tree) result.tree = memory.tree;
  if (memory.temporal) result.temporal = memory.temporal;
  return result;
}

function createMemoryExportCommand(): Command {
  return new Command("export")
    .description("export memories with filters")
    .argument("[file]", "output file or directory (stdout if omitted)")
    .option("--tree <filter>", "tree path filter")
    .option("--format <fmt>", "output format: json, yaml, md", "json")
    .option("--meta <json>", "metadata filter (JSON)")
    .option("--limit <n>", "max memories to export", "1000")
    .option("--temporal-contains <ts>", "memory must contain this point")
    .option("--temporal-overlaps <range>", "memory must overlap (start,end)")
    .option("--temporal-within <range>", "memory must be within (start,end)")
    .action(async (file: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const format = opts.format as "json" | "yaml" | "md";
      if (!["json", "yaml", "md"].includes(format)) {
        handleError(
          new Error("Invalid --format: must be json, yaml, or md"),
          fmt,
        );
      }

      // Build search params (filter-only, no semantic/fulltext)
      const searchParams: Record<string, unknown> = {
        limit: Number.parseInt(opts.limit, 10),
        orderBy: "asc" as const,
      };
      if (opts.tree) searchParams.tree = opts.tree;
      if (opts.meta) searchParams.meta = parseMeta(opts.meta);

      // Build temporal filter
      if (opts.temporalContains) {
        searchParams.temporal = { contains: opts.temporalContains };
      } else if (opts.temporalOverlaps) {
        const parts = opts.temporalOverlaps
          .split(",")
          .map((s: string) => s.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          handleError(new Error("--temporal-overlaps requires start,end"), fmt);
        }
        searchParams.temporal = {
          overlaps: { start: parts[0], end: parts[1] },
        };
      } else if (opts.temporalWithin) {
        const parts = opts.temporalWithin
          .split(",")
          .map((s: string) => s.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          handleError(new Error("--temporal-within requires start,end"), fmt);
        }
        searchParams.temporal = {
          within: { start: parts[0], end: parts[1] },
        };
      }

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.memory.search(
          searchParams as Parameters<typeof engine.memory.search>[0],
        );

        const memories = result.results.map((r: Record<string, unknown>) =>
          toExportable(r as Record<string, unknown>),
        );

        if (memories.length === 0) {
          output({ count: 0 }, fmt, () => {
            clack.log.warn("No memories found matching filters.");
          });
          return;
        }

        // Format output
        if (format === "md") {
          // Markdown: directory of .md files
          if (!file) {
            // Stdout — only allowed for single memory
            if (memories.length === 1 && memories[0]) {
              console.log(formatMemoryAsMarkdown(memories[0]));
            } else {
              handleError(
                new Error(
                  `Cannot write ${memories.length} memories as Markdown to stdout. Specify a directory path.`,
                ),
                fmt,
              );
            }
          } else {
            // Write directory
            if (!existsSync(file)) {
              mkdirSync(file, { recursive: true });
            }
            for (const mem of memories) {
              const filename = `${mem.id}.md`;
              const filepath = join(file, filename);
              writeFileSync(filepath, formatMemoryAsMarkdown(mem), "utf-8");
            }
            output({ count: memories.length, directory: file }, fmt, () => {
              clack.log.success(
                `Exported ${memories.length} ${memories.length === 1 ? "memory" : "memories"} to ${file}/`,
              );
            });
          }
        } else if (format === "yaml") {
          const content = yamlStringify(memories, { lineWidth: 0 });
          if (file) {
            writeFileSync(file, content, "utf-8");
            output({ count: memories.length, file }, fmt, () => {
              clack.log.success(
                `Exported ${memories.length} ${memories.length === 1 ? "memory" : "memories"} to ${file}`,
              );
            });
          } else {
            console.log(content);
          }
        } else {
          // JSON (default)
          const content = JSON.stringify(memories, null, 2);
          if (file) {
            writeFileSync(file, `${content}\n`, "utf-8");
            output({ count: memories.length, file }, fmt, () => {
              clack.log.success(
                `Exported ${memories.length} ${memories.length === 1 ? "memory" : "memories"} to ${file}`,
              );
            });
          } else {
            console.log(content);
          }
        }
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

// =============================================================================
// ANSI Markdown Renderer
// =============================================================================

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const YELLOW = "\x1b[33m";

const BOLD_OFF = "\x1b[22m";
const DIM_OFF = "\x1b[22m";
const ITALIC_OFF = "\x1b[23m";
const UNDERLINE_OFF = "\x1b[24m";
const COLOR_OFF = "\x1b[39m";

const ansiCallbacks = {
  heading: (children: string, { level }: { level: number }) => {
    const prefix = "#".repeat(level);
    return `\n${BOLD}${UNDERLINE}${prefix} ${children}${RESET}\n\n`;
  },
  paragraph: (children: string) => `${children}\n\n`,
  strong: (children: string) => `${BOLD}${children}${BOLD_OFF}`,
  emphasis: (children: string) => `${ITALIC}${children}${ITALIC_OFF}`,
  codespan: (children: string) => `${CYAN}${children}${COLOR_OFF}`,
  code: (children: string, meta?: { language?: string }) => {
    const lang = meta?.language ? ` ${DIM}(${meta.language})${DIM_OFF}` : "";
    const border = `${DIM}───${DIM_OFF}`;
    return `${border}${lang}\n${DIM}${children.trimEnd()}${DIM_OFF}\n${border}\n\n`;
  },
  link: (children: string, { href }: { href: string }) => {
    if (children === href)
      return `${UNDERLINE}${BLUE}${href}${COLOR_OFF}${UNDERLINE_OFF}`;
    return `${children} (${UNDERLINE}${BLUE}${href}${COLOR_OFF}${UNDERLINE_OFF})`;
  },
  blockquote: (children: string) => {
    const lines = children.trimEnd().split("\n");
    return `${lines.map((l) => `${DIM}│${DIM_OFF} ${l}`).join("\n")}\n\n`;
  },
  listItem: (
    children: string,
    {
      index,
      depth,
      ordered,
      start,
      checked,
    }: {
      index: number;
      depth: number;
      ordered: boolean;
      start?: number;
      checked?: boolean;
    },
  ) => {
    const indent = "  ".repeat(depth);
    let marker: string;
    if (checked === true) marker = `${YELLOW}✓${COLOR_OFF}`;
    else if (checked === false) marker = `${DIM}○${DIM_OFF}`;
    else if (ordered) marker = `${(start ?? 1) + index}.`;
    else marker = "•";
    return `${indent}${marker} ${children.trimEnd()}\n`;
  },
  list: (children: string) => `${children}\n`,
  hr: () => `${DIM}${"─".repeat(40)}${DIM_OFF}\n\n`,
  image: (_children: string, { src, title }: { src: string; title?: string }) =>
    `${DIM}[image: ${title || src}]${DIM_OFF}`,
  strikethrough: (children: string) => `\x1b[9m${children}\x1b[29m`,

  // Table rendering
  table: (children: string) => `${children}\n`,
  thead: (children: string) => children,
  tbody: (children: string) => children,
  tr: (children: string) => `${children}\n`,
  th: (children: string) => `${BOLD}${children}${BOLD_OFF}\t`,
  td: (children: string) => `${children}\t`,
};

/**
 * Render markdown content as ANSI-formatted text for the terminal.
 */
function renderMarkdownAnsi(content: string): string {
  return Bun.markdown.render(content, ansiCallbacks, {
    tables: true,
    strikethrough: true,
    tasklists: true,
  });
}

// =============================================================================
// View Command
// =============================================================================

function createMemoryViewCommand(): Command {
  return new Command("view")
    .description("view a memory rendered in the terminal")
    .argument("<id>", "memory ID")
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const memory = await engine.memory.get({ id });

        // JSON/YAML output falls back to structured output (same as get)
        if (fmt !== "text") {
          output(memory, fmt, () => {});
          return;
        }

        // Build YAML frontmatter
        const frontmatter: Record<string, unknown> = { id: memory.id };
        if (memory.tree) frontmatter.tree = memory.tree;
        if (
          memory.meta &&
          typeof memory.meta === "object" &&
          Object.keys(memory.meta).length > 0
        ) {
          frontmatter.meta = memory.meta;
        }
        if (memory.temporal) frontmatter.temporal = memory.temporal;
        if (memory.createdAt) frontmatter.created_at = memory.createdAt;

        const yaml = yamlStringify(frontmatter, { lineWidth: 0 }).trimEnd();
        const header = `${DIM}---\n${yaml}\n---${RESET}`;

        // Render content as ANSI markdown
        const rendered = renderMarkdownAnsi(memory.content);

        console.log(`\n${header}\n\n${rendered.trimEnd()}\n`);
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

// =============================================================================
// Command Group
// =============================================================================

export function createMemoryCommand(): Command {
  const memory = new Command("memory").description("manage memories");
  memory.addCommand(createMemoryCreateCommand());
  memory.addCommand(createMemoryGetCommand());
  memory.addCommand(createMemoryViewCommand());
  memory.addCommand(createMemorySearchCommand());
  memory.addCommand(createMemoryUpdateCommand());
  memory.addCommand(createMemoryDeleteCommand());
  memory.addCommand(createMemoryEditCommand());
  memory.addCommand(createMemoryTreeCommand());
  memory.addCommand(createMemoryMoveCommand());
  memory.addCommand(createMemoryImportCommand());
  memory.addCommand(createMemoryExportCommand());
  return memory;
}
