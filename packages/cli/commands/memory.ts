/**
 * me memory — memory management commands.
 *
 * - me memory create [content]: Create a memory
 * - me memory get <id>: Get a memory by ID (ANSI-rendered in TTY, raw markdown when piped)
 * - me memory search [query]: Hybrid search
 * - me memory update <id>: Update a memory
 * - me memory delete <id-or-path>: Delete a single memory (by ID or tree/name path)
 * - me memory deltree <tree>: Delete every memory under a tree path
 * - me memory edit <id>: Open in $EDITOR
 * - me memory count <tree>: Count memories matching a tree filter
 * - me memory tree [filter]: Show tree structure
 * - me memory copy <src> <dst>: Copy memories between tree paths
 * - me memory move <src> <dst>: Move memories between tree paths
 * - me memory import [files...]: Import from files/stdin
 * - me memory export [file]: Export with filters
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { stringify as yamlStringify } from "yaml";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import {
  buildMemoryClient,
  handleError,
  isAppErrorCode,
  requireMemoryAuth,
  requireSpace,
  shellTildeExpansionHint,
} from "../util.ts";
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

export function parseMaxCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Invalid --max-count: expected a positive integer");
  }
  return parsed;
}

export function formatMemoryCount(count: number, maxCount?: number): string {
  const noun = count === 1 ? "memory" : "memories";
  if (maxCount !== undefined && count === maxCount) {
    return `at least ${count} ${noun}`;
  }
  return `${count} ${noun}`;
}

/**
 * Resolve a collision-free `.md` export filename for `base` (a memory name, or
 * its id when unnamed) within `dir`, recording the choice in `used`.
 *
 * Memory names are unique in the database, but distinct names can still map to
 * the same file on disk: `foo` and `foo.md` both want `foo.md`, and a
 * case-insensitive filesystem also conflates `Foo` and `foo`. `used` maps each
 * directory to the set of filenames already claimed there (compared
 * lowercased). On a clash the memory's unique id is inserted before the `.md`
 * extension so nothing is silently overwritten; the common no-collision case is
 * unchanged (`<name>.md`).
 */
export function uniqueExportFilename(
  dir: string,
  base: string,
  id: string,
  used: Map<string, Set<string>>,
): string {
  let claimed = used.get(dir);
  if (!claimed) {
    claimed = new Set<string>();
    used.set(dir, claimed);
  }
  const stem = base.endsWith(".md") ? base.slice(0, -3) : base;
  let candidate = `${stem}.md`;
  if (claimed.has(candidate.toLowerCase())) {
    // Disambiguate with the unique id. This can only itself clash if another
    // memory is literally *named* `${stem}.${id}` — astronomically unlikely,
    // so surface it as an error rather than silently guessing another name.
    candidate = `${stem}.${id}.md`;
    if (claimed.has(candidate.toLowerCase())) {
      throw new Error(
        `Cannot pick a unique export filename in '${dir}': '${candidate}' is already taken (a memory named like another's id?).`,
      );
    }
  }
  claimed.add(candidate.toLowerCase());
  return candidate;
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
  if (memory.name) frontmatter.name = memory.name;
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
    .option(
      "--tree <path>",
      "tree path ('share' for shared, '~' for private home)",
    )
    .option("--name <slug>", "filename-like leaf name, unique within the tree")
    .option("--meta <json>", "metadata as JSON")
    .option("--temporal <range>", "temporal range (start[,end])")
    .option("--replace", "on conflict, replace the existing memory in place")
    .option("--ignore", "on conflict, skip and keep the existing memory")
    .action(async (positionalContent: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

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

      if (!opts.tree) {
        if (fmt === "text") {
          clack.log.error(
            "No tree path provided. Pass --tree <path> ('share' for shared memories, '~' for your private home).",
          );
        } else {
          output({ error: "No tree path provided" }, fmt, () => {});
        }
        process.exit(1);
      }

      // `--name ""` is an error, not "unnamed": omit --name for an unnamed
      // memory. (Clearing an existing name is an update-only op: `update
      // --name ""`.) Caught here so the user gets a clear message rather than a
      // schema rejection round-trip.
      if (opts.name === "") {
        if (fmt === "text") {
          clack.log.error(
            "Empty --name. Omit --name for an unnamed memory, or pass a filename-like slug.",
          );
        } else {
          output({ error: "Empty --name is not a valid name" }, fmt, () => {});
        }
        process.exit(1);
      }

      const client = buildMemoryClient(creds);

      try {
        const params: Record<string, unknown> = { content };
        params.tree = opts.tree;
        // Empty is rejected above; here name is either omitted or a real slug.
        if (opts.name) params.name = opts.name;
        if (opts.meta) params.meta = parseMeta(opts.meta);
        if (opts.temporal) params.temporal = parseTemporal(opts.temporal);
        if (opts.replace) params.onConflict = "replace";
        else if (opts.ignore) params.onConflict = "ignore";

        const memory = await client.memory.create(
          params as Parameters<typeof client.memory.create>[0],
        );

        output(memory, fmt, () => {
          clack.log.success(`Created memory ${memory.id}`);
          if (memory.tree) console.log(`  Tree: ${memory.tree}`);
          if (memory.name) console.log(`  Name: ${memory.name}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryGetCommand(): Command {
  return new Command("get")
    .description("get a memory by ID or by its tree/name path")
    .argument("<id-or-path>", "memory ID (UUIDv7) or tree/name path")
    .option("--raw", "output raw Markdown with YAML frontmatter (no ANSI)")
    .action(async (ref: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        const memory = UUIDV7_RE.test(ref)
          ? await client.memory.get({ id: ref })
          : await client.memory.getByPath({ path: ref });

        // --json / --yaml: structured output
        if (fmt !== "text") {
          output(memory, fmt, () => {});
          return;
        }

        // --raw or piped/redirected: raw Markdown with YAML frontmatter
        if (opts.raw || !process.stdout.isTTY) {
          console.log(
            formatMemoryAsMarkdown(
              memory as unknown as Record<string, unknown>,
            ),
          );
          return;
        }

        // TTY: ANSI-rendered markdown with dimmed frontmatter
        const frontmatter: Record<string, unknown> = { id: memory.id };
        if (memory.tree) frontmatter.tree = memory.tree;
        if (memory.name) frontmatter.name = memory.name;
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
        const rendered = renderMarkdownAnsi(memory.content);

        console.log(`\n${header}\n\n${rendered.trimEnd()}\n`);
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemorySearchCommand(): Command {
  return new Command("search")
    .description("search memories")
    .argument("[query]", "hybrid search query (semantic + fulltext)")
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
    .option("--semantic-threshold <n>", "minimum semantic score (0-1)")
    .option("--temporal-contains <ts>", "memory must contain this point")
    .option("--temporal-overlaps <range>", "memory must overlap (start,end)")
    .option("--temporal-within <range>", "memory must be within (start,end)")
    .option("--weight-semantic <w>", "semantic weight (0-1)")
    .option("--weight-fulltext <w>", "fulltext weight (0-1)")
    .option(
      "--order-by <dir>",
      "filter-only search: order by recency, desc (default, newest first) | asc",
    )
    .action(async (query: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      // Resolve search text. A positional query runs hybrid search
      if (query && opts.semantic && opts.fulltext) {
        const error =
          "Positional query is masked by --semantic and --fulltext flags.";
        if (fmt === "text") {
          clack.log.error(error);
        } else {
          output({ error }, fmt, () => {});
        }
        process.exit(1);
      }

      const semantic = opts.semantic ?? query ?? null;
      const fulltext = opts.fulltext ?? query ?? null;
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

      const client = buildMemoryClient(creds);

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
        if (opts.semanticThreshold)
          params.semanticThreshold = Number.parseFloat(opts.semanticThreshold);
        if (opts.orderBy) params.orderBy = opts.orderBy;

        const result = await client.memory.search(
          params as Parameters<typeof client.memory.search>[0],
        );

        output(result, fmt, () => {
          console.log(
            `Found ${result.total} results (showing ${result.results.length})`,
          );
          if (result.results.length === 0) {
            const hint = shellTildeExpansionHint(tree ?? undefined);
            if (hint) clack.log.warn(hint);
            return;
          }
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
    .description("update a memory (by ID or tree/name path)")
    .argument("<id-or-path>", "memory ID (UUIDv7) or tree/name path")
    .requiredOption(
      "--version-hash <hash>",
      "current versionHash from a recent get/search/create/update response",
    )
    .option("--content <text>", "new content (use - for stdin)")
    .option("--tree <path>", "new tree path (moves the memory)")
    .option(
      "--name <slug>",
      "new leaf name (renames; pass an empty string to clear it)",
    )
    .option("--meta <json>", "new metadata (replaces existing)")
    .option("--temporal <range>", "new temporal range (start[,end])")
    .action(async (ref: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      // Resolve content
      let content = opts.content;
      if (content === "-") {
        content = (await Bun.stdin.text()).trimEnd();
      }

      if (
        !content &&
        !opts.tree &&
        opts.name === undefined &&
        !opts.meta &&
        !opts.temporal
      ) {
        const msg =
          "At least one update field required (--content, --tree, --name, --meta, or --temporal).";
        if (fmt === "text") {
          clack.log.error(msg);
        } else {
          output({ error: msg }, fmt, () => {});
        }
        process.exit(1);
      }

      const client = buildMemoryClient(creds);

      try {
        // update is id-addressed; resolve a tree/name ref to its id first.
        const id = UUIDV7_RE.test(ref)
          ? ref
          : (await client.memory.getByPath({ path: ref })).id;
        const params: Record<string, unknown> = {
          id,
          versionHash: opts.versionHash,
        };
        if (content) params.content = content;
        if (opts.tree) params.tree = opts.tree;
        // --name "" clears the name (empty is never a valid name); a non-empty
        // value renames.
        if (opts.name !== undefined) {
          params.name = opts.name === "" ? null : opts.name;
        }
        if (opts.meta) params.meta = parseMeta(opts.meta);
        if (opts.temporal) params.temporal = parseTemporal(opts.temporal);

        const memory = await client.memory.update(
          params as Parameters<typeof client.memory.update>[0],
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
    .description("delete a single memory by ID or by its tree/name path")
    .argument("<id-or-path>", "memory ID (UUIDv7) or tree/name path")
    .action(async (ref: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        // A UUID deletes by id; anything else is a tree/name path (the segment
        // after the final '/') and deletes at most that one named memory. To
        // delete a whole subtree, use `deltree`. A ref that matches nothing —
        // id or path — raises NOT_FOUND (caught below), so reaching `output`
        // means it was deleted.
        const result = UUIDV7_RE.test(ref)
          ? await client.memory.delete({ id: ref })
          : await client.memory.deleteByPath({ path: ref });
        output(result, fmt, () => {
          clack.log.success(`Deleted memory ${ref}`);
        });
      } catch (error) {
        // A non-UUID ref that matched no single memory but has memories beneath
        // it was almost certainly meant as a subtree delete — point at deltree.
        if (!UUIDV7_RE.test(ref) && isAppErrorCode(error, "NOT_FOUND")) {
          try {
            const { count } = await client.memory.countTree({ tree: ref });
            if (count > 0) {
              const noun = count === 1 ? "memory" : "memories";
              handleError(
                new Error(
                  `No memory at '${ref}'. ${count} ${noun} exist under that tree — to delete the whole subtree run: me memory deltree ${ref}`,
                ),
                fmt,
              );
              return;
            }
          } catch {
            // Couldn't probe the subtree — fall through to the original error.
          }
        }
        handleError(error, fmt);
      }
    });
}

function createMemoryDeltreeCommand(): Command {
  return new Command("deltree")
    .alias("rmtree")
    .description("delete every memory at or under a tree path (a subtree)")
    .argument("<tree>", "tree path; all memories at or under it are deleted")
    .option("--dry-run", "preview what would be deleted without deleting")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (tree: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        // Always preview first so --dry-run can NEVER delete, and so the
        // confirmation prompt shows an accurate count.
        const preview = await client.memory.deleteTree({ tree, dryRun: true });
        if (preview.count === 0) {
          output({ count: 0 }, fmt, () => {
            const hint = shellTildeExpansionHint(tree);
            clack.log.warn(
              `No memories found under '${tree}'${hint ? `\n${hint}` : ""}`,
            );
          });
          return;
        }

        const noun = preview.count === 1 ? "memory" : "memories";
        if (fmt === "text") {
          console.log(
            `  ${preview.count} ${noun} will be deleted under '${tree}'`,
          );
        }
        if (opts.dryRun) {
          output({ dryRun: true, count: preview.count }, fmt, () => {});
          return;
        }
        if (fmt === "text" && !opts.yes) {
          const confirmed = await clack.confirm({
            message: `Delete ${preview.count} ${noun}?`,
            initialValue: false,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }
        const result = await client.memory.deleteTree({ tree, dryRun: false });
        output(result, fmt, () => {
          clack.log.success(
            `Deleted ${result.count} ${result.count === 1 ? "memory" : "memories"}`,
          );
        });
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
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        await editMemory(client, id);
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createMemoryCountCommand(): Command {
  return new Command("count")
    .description("count memories matching a tree filter")
    .argument(
      "<tree>",
      "tree filter: path prefix, lquery pattern, or ltxtquery label search",
    )
    .option("--max-count <n>", "stop counting after this many matches")
    .action(async (tree: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        const maxCount = parseMaxCount(opts.maxCount);
        const result = await client.memory.countTree({ tree, maxCount });

        await output(result, fmt, () => {
          console.log(formatMemoryCount(result.count, maxCount));
          if (result.count === 0) {
            const hint = shellTildeExpansionHint(tree);
            if (hint) clack.log.warn(hint);
          }
        });
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
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        const params: Record<string, unknown> = {};
        if (filter) params.tree = filter;
        if (opts.levels) params.levels = Number.parseInt(opts.levels, 10);

        const result = await client.memory.tree(
          params as Parameters<typeof client.memory.tree>[0],
        );

        output(result, fmt, () => {
          console.log(renderTree(result.nodes, filter));
          if (result.nodes.length === 0) {
            const hint = shellTildeExpansionHint(filter);
            if (hint) clack.log.warn(hint);
          }
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
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        // Always dry-run first to show preview
        const preview = await client.memory.move({
          source: src,
          destination: dst,
          dryRun: true,
        });

        if (preview.count === 0) {
          output({ count: 0 }, fmt, () => {
            const hint = shellTildeExpansionHint(src);
            clack.log.warn(
              `No memories found under '${src}'${hint ? `\n${hint}` : ""}`,
            );
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

        const result = await client.memory.move({
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

function createMemoryCopyCommand(): Command {
  return new Command("copy")
    .alias("cp")
    .description("copy memories between tree paths")
    .argument("<src>", "source tree path")
    .argument("<dst>", "destination tree path")
    .option("--dry-run", "preview what would be copied")
    .option("-y, --yes", "skip confirmation")
    .action(async (src: string, dst: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

      const client = buildMemoryClient(creds);

      try {
        // Always dry-run first to show preview
        const preview = await client.memory.copy({
          source: src,
          destination: dst,
          dryRun: true,
        });

        if (preview.count === 0) {
          output({ count: 0 }, fmt, () => {
            const hint = shellTildeExpansionHint(src);
            clack.log.warn(
              `No memories found under '${src}'${hint ? `\n${hint}` : ""}`,
            );
          });
          return;
        }

        if (fmt === "text") {
          console.log(
            `  ${preview.count} ${preview.count === 1 ? "memory" : "memories"} will be copied from '${src}' to '${dst}'`,
          );
        }

        if (opts.dryRun) {
          output({ dryRun: true, count: preview.count }, fmt, () => {});
          return;
        }

        // Confirm unless --yes
        if (fmt === "text" && !opts.yes) {
          const confirmed = await clack.confirm({
            message: `Copy ${preview.count} ${preview.count === 1 ? "memory" : "memories"}?`,
            initialValue: false,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }

        const result = await client.memory.copy({
          source: src,
          destination: dst,
        });

        output(result, fmt, () => {
          clack.log.success(
            `Copied ${result.count} ${result.count === 1 ? "memory" : "memories"} from '${src}' to '${dst}'`,
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
  if (memory.name) result.name = memory.name;
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
      requireMemoryAuth(creds, fmt);
      requireSpace(creds, fmt);

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

      const client = buildMemoryClient(creds);

      try {
        const result = await client.memory.search(
          searchParams as Parameters<typeof client.memory.search>[0],
        );

        const memories = result.results.map((r: Record<string, unknown>) =>
          toExportable(r as Record<string, unknown>),
        );

        if (memories.length === 0) {
          output({ count: 0 }, fmt, () => {
            const hint = shellTildeExpansionHint(opts.tree);
            clack.log.warn(
              `No memories found matching filters.${hint ? `\n${hint}` : ""}`,
            );
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
            // Write a directory tree mirroring the memory tree:
            //   <dir>/<tree as folders>/<name or id>.md
            // Named files get a legible filename (`.md` appended unless already
            // present); unnamed ones fall back to the uuid. Distinct names can
            // still map to one file on disk (`foo` vs `foo.md`, or case-insensitive
            // filesystems), so `uniqueExportFilename` disambiguates by id.
            if (!existsSync(file)) {
              mkdirSync(file, { recursive: true });
            }
            const usedByDir = new Map<string, Set<string>>();
            for (const mem of memories) {
              const treeDir =
                typeof mem.tree === "string"
                  ? mem.tree.replace(/^\//, "") // drop the absolute leading slash
                  : "";
              const base =
                typeof mem.name === "string" && mem.name
                  ? mem.name
                  : String(mem.id);
              const dir = treeDir ? join(file, treeDir) : file;
              mkdirSync(dir, { recursive: true });
              const filename = uniqueExportFilename(
                dir,
                base,
                String(mem.id),
                usedByDir,
              );
              writeFileSync(
                join(dir, filename),
                formatMemoryAsMarkdown(mem),
                "utf-8",
              );
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
// Command Group
// =============================================================================

/**
 * Build a fresh set of the memory subcommands. A Commander command can only be
 * attached to one parent, so callers that want them in two places (the `memory`
 * group and the top-level aliases) each call this for their own instances.
 */
function memorySubcommands(): Command[] {
  return [
    createMemoryCreateCommand(),
    createMemoryGetCommand(),
    createMemorySearchCommand(),
    createMemoryUpdateCommand(),
    createMemoryDeleteCommand(),
    createMemoryDeltreeCommand(),
    createMemoryEditCommand(),
    createMemoryCountCommand(),
    createMemoryTreeCommand(),
    createMemoryCopyCommand(),
    createMemoryMoveCommand(),
    createMemoryImportCommand(),
    createMemoryExportCommand(),
  ];
}

export function createMemoryCommand(): Command {
  const memory = new Command("memory").description("manage memories");
  for (const c of memorySubcommands()) memory.addCommand(c);
  return memory;
}

/**
 * The memory subcommands as top-level aliases (`me search`, `me create`, …) so
 * the `memory` word is optional for the common data-plane operations.
 *
 * `import` is excluded: the top-level `import` name belongs to the
 * `me import` source group (see commands/import-group.ts), where the file
 * importer lives as `me import memories`. `me memory import` remains its
 * alias.
 */
export function createMemoryAliasCommands(): Command[] {
  return memorySubcommands().filter((c) => c.name() !== "import");
}
