/**
 * `me import slab <dir>` — import a Slab knowledge-base export as memories.
 *
 * Walks a Slab export — either an unzipped directory of markdown posts nested
 * in topic folders, or the raw `.zip` (extracted to a temp dir first; see
 * importers/slab-zip.ts) — and writes one memory per `.md` file under
 * `<tree-root>.<topic>.<subtopic>...`, reconstructing Slab's topic hierarchy as
 * the ltree path. The post body is the content; the human-readable title, topic
 * path, and original filename go in `meta`; a leading date in the filename
 * becomes the memory's temporal.
 *
 * Idempotency keys on `(tree, name)` and submits through `onConflict: "replace"`
 * with a deterministic `meta.importer_version`, so a re-run is a no-op when
 * nothing changed and an importer_version bump re-renders every post in place.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { Command } from "commander";
import { batchCreateChunked } from "../chunk.ts";
import { resolveCredentials } from "../credentials.ts";
import { createProgressReporter, dedupBy } from "../importers/index.ts";
import {
  buildSlabMemory,
  DEFAULT_SLAB_TREE_ROOT,
  DEFAULT_UNCATEGORIZED_NODE,
  type SlabMemoryContext,
  walkSlabDir,
} from "../importers/slab.ts";
import { resolveSlabSource } from "../importers/slab-zip.ts";
import { getOutputFormat, output } from "../output.ts";
import {
  buildMemoryClient,
  handleError,
  requireAuth,
  requireSpace,
} from "../util.ts";
import { VALID_TREE_ROOT_RE } from "./import.ts";

/** Validated options for one Slab import run. */
export interface SlabImportOptions {
  /** Export source: a directory to walk, or a `.zip` to extract first. */
  source: string;
  /** Tree root under which the topic hierarchy is placed. */
  treeRoot: string;
  /** Bucket label for topic-less posts at the export root. */
  uncategorizedNode: string;
  /** Parse a leading date in the filename into the memory's temporal. */
  parseTemporal: boolean;
  /** Report without writing. */
  dryRun: boolean;
  /** Per-file progress output. */
  verbose: boolean;
}

/** Label syntax for `--uncategorized-node` (a single ltree label). */
const VALID_NODE_LABEL_RE = /^[a-z0-9_]+$/;

/** Validate raw Commander opts into a typed option set. */
export function buildSlabImportOptions(
  sourceArg: string,
  opts: Record<string, unknown>,
): SlabImportOptions {
  const treeRoot =
    typeof opts.treeRoot === "string" ? opts.treeRoot : DEFAULT_SLAB_TREE_ROOT;
  if (!VALID_TREE_ROOT_RE.test(treeRoot)) {
    throw new Error(
      `Invalid --tree-root: '${treeRoot}'. Use ltree labels ([A-Za-z0-9_-]) separated by '.' or '/', with an optional leading '~' for your home.`,
    );
  }
  const uncategorizedNode =
    typeof opts.uncategorizedNode === "string"
      ? opts.uncategorizedNode
      : DEFAULT_UNCATEGORIZED_NODE;
  if (!VALID_NODE_LABEL_RE.test(uncategorizedNode)) {
    throw new Error(
      `Invalid --uncategorized-node: '${uncategorizedNode}'. Must match [a-z0-9_]+`,
    );
  }
  return {
    source: sourceArg,
    treeRoot,
    uncategorizedNode,
    // Commander sets `temporal` false when `--no-temporal` is passed.
    parseTemporal: opts.temporal !== false,
    dryRun: opts.dryRun === true,
    verbose: opts.verbose === true,
  };
}

/** Structured result of one run (also the --json/--yaml output shape). */
interface SlabImportResult {
  source: string;
  treeRoot: string;
  dryRun: boolean;
  filesScanned: number;
  inserted: number;
  /** Unchanged server-side (idempotent re-import). */
  skipped: number;
  failed: number;
  errors: Array<{ source: string; error: string }>;
}

/** Run one Slab import end-to-end and render the outcome. */
export async function runSlabImport(
  sourceArg: string,
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const creds = resolveCredentials(
    typeof globalOpts.server === "string" ? globalOpts.server : undefined,
  );
  const fmt = getOutputFormat(globalOpts);
  requireAuth(creds, fmt);
  requireSpace(creds, fmt);

  let opts: SlabImportOptions;
  try {
    opts = buildSlabImportOptions(sourceArg, rawOpts);
  } catch (error) {
    handleError(error, fmt);
  }

  const sourcePath = resolve(opts.source);
  if (!existsSync(sourcePath)) {
    handleError(new Error(`Source not found: ${opts.source}`), fmt);
  }
  // A `.zip` is extracted into a temp dir; a directory passes through. The
  // returned cleanup removes any temp dir and runs in the finally below.
  let resolved: Awaited<ReturnType<typeof resolveSlabSource>>;
  try {
    resolved = await resolveSlabSource(sourcePath);
  } catch (error) {
    handleError(error, fmt);
  }
  const dir = resolved.dir;

  const ctx: SlabMemoryContext = {
    treeRoot: opts.treeRoot,
    uncategorizedNode: opts.uncategorizedNode,
    parseTemporal: opts.parseTemporal,
    usedNames: new Map(),
  };

  const engine = buildMemoryClient(creds);
  const progress =
    fmt === "text" ? createProgressReporter(process.stderr) : undefined;
  progress?.start();

  // Remove any temp extraction dir before a terminal point. `process.exit`
  // (which handleError calls) skips `finally`, so cleanup is invoked explicitly
  // on every path rather than via a finally block. `cleanup` is idempotent.
  const failAndClean = async (error: unknown): Promise<never> => {
    progress?.stop();
    await resolved.cleanup();
    handleError(error, fmt, { creds, scope: "space" });
  };

  const planned: Array<{ payload: MemoryCreateParams }> = [];
  let filesScanned = 0;
  const errors: Array<{ source: string; error: string }> = [];

  try {
    for await (const file of walkSlabDir(dir)) {
      filesScanned++;
      progress?.process(file.relPath);
      const payload = buildSlabMemory(file.relPath, file.content, ctx);
      planned.push({ payload });
      if (opts.verbose && fmt === "text") {
        const line = `  ${payload.tree} / ${payload.name}`;
        if (progress) progress.log(line);
        else console.log(line);
      }
    }
  } catch (error) {
    await failAndClean(error);
  }

  // Dedup on the (tree, name) idempotency key — defensive; the sorted walk
  // plus per-tree name registry already make these unique.
  const { unique } = dedupBy(
    planned,
    (p) => `${p.payload.tree}\u0000${p.payload.name}`,
  );

  let inserted = 0;
  let skipped = 0;
  try {
    if (opts.dryRun) {
      inserted = unique.length;
    } else if (unique.length > 0) {
      const result = await batchCreateChunked(
        engine,
        unique.map((p) => p.payload),
        { onConflict: "replace" },
      );
      // A post "imported" if inserted or re-rendered; skipped = unchanged.
      inserted = result.results.filter(
        (r) => r.status === "inserted" || r.status === "updated",
      ).length;
      skipped = result.results.filter((r) => r.status === "skipped").length;
      for (const e of result.errors) {
        errors.push({ source: `chunk ${e.chunkIndex}`, error: e.error });
      }
    }
  } catch (error) {
    await failAndClean(error);
  }
  progress?.stop();

  // Success path: remove the temp dir before rendering + exiting.
  await resolved.cleanup();

  const structured: SlabImportResult = {
    // Report the original source the user passed, not the temp extraction dir.
    source: opts.source,
    treeRoot: opts.treeRoot,
    dryRun: opts.dryRun,
    filesScanned,
    inserted,
    skipped,
    failed: errors.length,
    errors,
  };

  output(structured, fmt, () => {
    const verb = opts.dryRun ? "Would import" : "Imported";
    clack.log.success(
      `${verb} ${inserted} new/updated, ${skipped} unchanged, ${errors.length} failed ` +
        `from ${filesScanned} Slab posts into ${opts.treeRoot}`,
    );
    for (const e of errors) {
      console.log(`    ✗ ${e.source}: ${e.error}`);
    }
  });

  if (errors.length > 0 && inserted === 0) process.exit(2);
  if (errors.length > 0) process.exit(1);
}

/** `me import slab` subcommand factory. */
export function createSlabImportCommand(): Command {
  return new Command("slab")
    .description("import a Slab knowledge-base export (a directory or .zip)")
    .argument("<source>", "path to the Slab export directory or .zip file")
    .option(
      "--tree-root <path>",
      `tree root under which the topic hierarchy is placed (default: ${DEFAULT_SLAB_TREE_ROOT})`,
    )
    .option(
      "--uncategorized-node <name>",
      `bucket label for topic-less posts at the export root (default: ${DEFAULT_UNCATEGORIZED_NODE})`,
    )
    .option(
      "--no-temporal",
      "do not derive a memory temporal from a leading date in the filename",
    )
    .option(
      "--dry-run",
      "parse and report what would be imported without writing",
    )
    .option("-v, --verbose", "per-file progress output")
    .action(async (sourceArg: string, opts, cmdRef) => {
      const globalOpts = cmdRef.optsWithGlobals();
      await runSlabImport(sourceArg, opts, globalOpts);
    });
}
