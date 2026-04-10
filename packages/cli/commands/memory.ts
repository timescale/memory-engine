/**
 * me memory — memory management commands.
 *
 * - me memory create [content]: Create a memory
 * - me memory get <id>: Get a memory by ID
 * - me memory search [query]: Hybrid search
 * - me memory update <id>: Update a memory
 * - me memory delete <id-or-tree>: Delete memory or tree
 * - me memory edit <id>: Open in $EDITOR
 * - me memory tree [filter]: Show tree structure
 * - me memory move <src> <dst>: Move memories between tree paths
 * - me memory import [files...]: Import from files/stdin
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory-engine/client";
import { Command } from "commander";
import { stringify as yamlStringify } from "yaml";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
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
        !tree &&
        !meta &&
        !opts.temporalContains &&
        !opts.temporalOverlaps &&
        !opts.temporalWithin
      ) {
        const msg =
          "At least one search criterion required (query, --semantic, --fulltext, --tree, --meta, or --temporal-*).";
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
          console.log();
          for (const r of result.results) {
            const idPrefix = r.id.slice(0, 8);
            const preview =
              r.content.length > 80
                ? `${r.content.slice(0, 80)}...`
                : r.content;
            const score = r.score < 1.0 ? ` (${r.score.toFixed(3)})` : "";
            const treePath = r.tree ? ` [${r.tree}]` : "";
            console.log(`  ${idPrefix}  ${preview}${treePath}${score}`);
          }
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
                  (max, n) => (n.count > max ? n.count : max),
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
    .description("move memories between tree paths")
    .argument("<src>", "source tree path")
    .argument("<dst>", "destination tree path")
    .option("-y, --yes", "skip confirmation")
    .action(async (src: string, dst: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      // Confirm unless --yes
      if (fmt === "text" && !opts.yes) {
        const confirmed = await clack.confirm({
          message: `Move all memories from '${src}' to '${dst}'?`,
          initialValue: false,
        });
        if (clack.isCancel(confirmed) || !confirmed) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
      }

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
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

// =============================================================================
// Command Group
// =============================================================================

export function createMemoryCommand(): Command {
  const memory = new Command("memory").description("manage memories");
  memory.addCommand(createMemoryCreateCommand());
  memory.addCommand(createMemoryGetCommand());
  memory.addCommand(createMemorySearchCommand());
  memory.addCommand(createMemoryUpdateCommand());
  memory.addCommand(createMemoryDeleteCommand());
  memory.addCommand(createMemoryEditCommand());
  memory.addCommand(createMemoryTreeCommand());
  memory.addCommand(createMemoryMoveCommand());
  memory.addCommand(createMemoryImportCommand());
  return memory;
}
