/**
 * `me import docs [dir]` — import a directory's markdown docs as memories.
 *
 * One memory per markdown file under `<tree>.docs.<relative dirs>` — the
 * full project TREE from `--tree` or the repo's `.me` `tree`, else
 * `<tree_root ?? ~/projects>.<project_slug>` (private by default). The
 * argument directory is the import root: trees derive relative to IT.
 *
 * Plain mode is the default: discover markdown files by walking the filesystem
 * under the argument directory, including generated or gitignored files, with
 * no git dates or repo-root assumptions. `--git-aware` opts into repo-managed
 * behavior: git discovery, gitignore filtering, git last-modified dates, and
 * the subdir-root safety guard. `--git-aware --include-ignored` keeps repo
 * context while also including ignored/generated files.
 *
 * Idempotency keys on `(tree, name)` and submits through
 * `onConflict: "replace"` with deterministic meta, so a re-run is a no-op
 * when nothing changed, an edited doc updates in place, and an
 * importer_version bump re-renders everything.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import * as clack from "@clack/prompts";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { Command } from "commander";
import { BATCH_CREATE_BYTES_BUDGET, batchCreateChunked } from "../chunk.ts";
import { resolveCredentials, resolveCredentialsFor } from "../credentials.ts";
import {
  buildDocMemory,
  DEFAULT_DOC_PATTERNS,
  DOCS_META_SOURCE,
  DOCS_NODE_NAME,
  type DocsMemoryContext,
  discoverPlainFiles,
  filterDocPaths,
} from "../importers/docs.ts";
import {
  isShallowRepository,
  lastModifiedByPath,
  listGitFiles,
} from "../importers/git-files.ts";
import {
  createProgressReporter,
  DEFAULT_PRIVATE_TREE_ROOT,
  dedupBy,
} from "../importers/index.ts";
import { normalizeTreeLabel } from "../importers/markdown-files.ts";
import {
  detectGitContext,
  normalizeProjectSlug,
  ProjectRegistry,
} from "../importers/project.ts";
import { getOutputFormat, output } from "../output.ts";
import { discoverProjectConfig } from "../project-config.ts";
import {
  buildMemoryClient,
  displayTreePath,
  handleError,
  requireAuth,
  requireSpace,
} from "../util.ts";
import { VALID_TREE_ROOT_RE } from "./import.ts";

/** Validated options for one docs import run. */
export interface DocsImportOptions {
  /** Import root (trees derive relative to it). Default: cwd. */
  dir: string;
  /** Full project tree to place the docs node under (no slug appended). */
  tree?: string;
  /** Include globs (replace the default md/markdown/mdx set). */
  include: string[];
  /** Exclude globs (subtract from the include set). */
  exclude: string[];
  /** Frontmatter key parsed as the temporal start. */
  temporalKey?: string;
  /** False (via --no-temporal): no temporal, no date-seeded ids. */
  parseTemporal: boolean;
  /** Delete previously-imported docs absent from this walk. */
  prune: boolean;
  /** Opt into repo-managed discovery/dates/root safety. */
  gitAware: boolean;
  /** Include ignored generated files while in git-aware mode. */
  includeIgnored: boolean;
  /** Allow a git-mode import root below the repo toplevel. */
  allowSubdirRoot: boolean;
  /**
   * An empty walk is a clean skip (info, exit 0) instead of a `--prune`
   * refusal — for orchestrated runs (`me import ci`) whose import root is the
   * repo toplevel by construction, where "no matching docs" means the repo
   * has no docs corpus, not that the run is mis-rooted.
   */
  skipIfEmpty?: boolean;
  /** Report without writing. */
  dryRun: boolean;
  /** Per-file progress output. */
  verbose: boolean;
}

/** Validate raw Commander opts into a typed option set. */
export function buildDocsImportOptions(
  dirArg: string | undefined,
  opts: Record<string, unknown>,
): DocsImportOptions {
  const tree = typeof opts.tree === "string" ? opts.tree : undefined;
  if (tree !== undefined && !VALID_TREE_ROOT_RE.test(tree)) {
    throw new Error(
      `Invalid --tree: '${tree}'. Use ltree labels ([A-Za-z0-9_-]) separated by '.' or '/', with an optional leading '~' for your home.`,
    );
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  const include = strings(opts.include);
  const exclude = strings(opts.exclude);
  const temporalKey =
    typeof opts.temporalKey === "string" && opts.temporalKey.length > 0
      ? opts.temporalKey
      : undefined;
  const gitAware = opts.gitAware === true;
  const includeIgnored = opts.includeIgnored === true;
  if (includeIgnored && !gitAware) {
    throw new Error(
      "--include-ignored requires --git-aware; plain mode already walks files on disk",
    );
  }
  return {
    dir: dirArg ?? ".",
    tree,
    include: include.length > 0 ? include : [...DEFAULT_DOC_PATTERNS],
    exclude,
    temporalKey,
    // Commander sets `temporal` false when `--no-temporal` is passed.
    parseTemporal: opts.temporal !== false,
    prune: opts.prune === true,
    gitAware,
    includeIgnored,
    allowSubdirRoot: opts.allowSubdirRoot === true,
    skipIfEmpty: opts.skipIfEmpty === true,
    dryRun: opts.dryRun === true,
    verbose: opts.verbose === true,
  };
}

/**
 * In git mode, an import root below the repo toplevel is refused unless
 * explicitly allowed: tree slots derive from the import root while the
 * project identity (slug, .me tree) stays repo-level, so runs rooted at
 * different directories mint parallel corpora under one docs root — and a
 * cross-root --prune deletes the other root's slots. `--include` scoping
 * from the toplevel achieves the same narrowing without re-rooting. Returns
 * the refusal message, or undefined when the root is fine.
 *
 * Plain mode has no implicit repo-root safety: it means "walk the files under
 * this directory". A root-sensitive --prune is the caller's explicit choice.
 */
export function subdirRootError(
  dir: string,
  gitRoot: string,
  docsTree: string,
  allowSubdirRoot: boolean,
): string | undefined {
  if (allowSubdirRoot) return undefined;
  // git prints physical paths; the argument may travel through symlinks
  // (macOS /tmp → /private/tmp), so compare realpaths.
  const dirReal = realpathSync(dir);
  const rootReal = realpathSync(gitRoot);
  if (dirReal === rootReal) return undefined;

  const rel = relative(rootReal, dirReal).split(sep).join("/");
  // Display-form docs root for the example destinations.
  const docsRoot = displayTreePath(docsTree);
  // Where a representative file would land under each root — the dirs are
  // slugified to ltree labels exactly as the importer would.
  const relLabels = rel.split("/").map(normalizeTreeLabel).join("/");
  return (
    `${dir} is a subfolder of the git repo at ${gitRoot}, and docs tree slots derive ` +
    `from the import root — the same file lands in different places depending on where a run is rooted. ` +
    `For example, ${rel}/setup.md would land at:\n` +
    `  ${docsRoot}/setup.md  (rooted here)\n` +
    `  ${docsRoot}/${relLabels}/setup.md  (rooted at the repo toplevel)\n` +
    `Mixing roots therefore creates parallel corpora, and a cross-root --prune deletes ` +
    `the other root's docs. Run from the repo root and scope with --include instead:\n` +
    `  me import docs ${gitRoot} --include '${rel}/**'\n` +
    `or pass --allow-subdir-root to keep subfolder-relative slots.`
  );
}

/**
 * Byte budget for the delete-orphans keep-list — the whole request must fit under
 * the server's body cap, so this mirrors BATCH_CREATE_BYTES_BUDGET's
 * headroom. In practice ~20k slots; beyond it prune refuses cleanly (a
 * NOT-IN keep-list is fundamentally un-chunkable: splitting it would delete
 * the union of "not in each chunk", i.e. nearly everything).
 */
export const PRUNE_KEEP_BYTES_BUDGET = BATCH_CREATE_BYTES_BUDGET;

/** A keep-list slot for memory.deleteOrphansInTree. */
export interface KeepSlot {
  tree: string;
  name: string;
}

/** The walked slot set, as the delete-orphans keep-list. */
export function buildKeepList(
  planned: Array<{ payload: MemoryCreateParams }>,
): KeepSlot[] {
  return planned.map((p) => {
    // Every doc payload is named (buildDocMemory always sets one). A nameless
    // payload would silently shrink the keep-set — fail fast instead: the
    // protocol would reject an empty name anyway, but with a far less
    // pointed error.
    if (p.payload.name == null || p.payload.name.length === 0) {
      throw new Error(
        `invariant violated: doc payload missing a name under ${p.payload.tree}`,
      );
    }
    return { tree: p.payload.tree, name: p.payload.name };
  });
}

/** Approximate wire size of the keep-list (UTF-8 JSON bytes). */
export function keepListBytes(keep: KeepSlot[]): number {
  return Buffer.byteLength(JSON.stringify(keep), "utf8");
}

/** Structured result of one run (also the --json/--yaml output shape). */
interface DocsImportResult {
  dir: string;
  /** Full docs root the run wrote under (`<project-tree>.docs`). */
  tree: string;
  /** Discovery mode: git ls-files vs plain directory walk. */
  mode: "git" | "plain";
  /** Set when a skipIfEmpty run found no matching docs and skipped cleanly. */
  skippedNoDocs?: boolean;
  /** Git-aware runs where git saw zero docs but a plain disk walk found docs. */
  gitIgnoredDocsOnDisk?: number;
  /** Set when git dates were dropped because the clone is shallow. */
  shallow?: boolean;
  dryRun: boolean;
  /** Files matching the include/exclude set. */
  filesScanned: number;
  /** Files skipped because they were empty after frontmatter/mdx stripping. */
  skippedEmpty: number;
  inserted: number;
  /** Rewritten in place (content/meta/temporal changed). */
  updated: number;
  /** Unchanged server-side (idempotent re-import). */
  skipped: number;
  /** Stale rows deleted by --prune (would-delete count in a dry run). */
  pruned: number;
  /** Display paths of the pruned rows. */
  prunedPaths: string[];
  /** Set when --prune was requested but refused; the reason. */
  pruneRefused?: string;
  failed: number;
  errors: Array<{ source: string; error: string }>;
}

/** Run one docs import end-to-end and render the outcome. */
export async function runDocsImport(
  dirArg: string | undefined,
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const fmt = getOutputFormat(globalOpts);

  let opts: DocsImportOptions;
  try {
    opts = buildDocsImportOptions(dirArg, rawOpts);
  } catch (error) {
    handleError(error, fmt);
  }

  const dir = resolve(opts.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    handleError(new Error(`Not a directory: ${opts.dir}`), fmt);
  }

  // Per-project resolution follows the TARGET directory, not the cwd (the
  // `me import git` pattern): the import root's own .me config supplies
  // server/space/tree, so importing another project's docs from anywhere
  // routes to that project. An explicit --config-dir/ME_CONFIG_DIR keeps the
  // ambient resolution the caller asked for; `--server` reaches both forms
  // (seeded).
  const serverFlag =
    typeof globalOpts.server === "string" ? globalOpts.server : undefined;
  const explicitConfigDir =
    typeof globalOpts.configDir === "string" ||
    Boolean(process.env.ME_CONFIG_DIR);
  let creds: ReturnType<typeof resolveCredentials>;
  try {
    creds = explicitConfigDir
      ? resolveCredentials(serverFlag)
      : resolveCredentialsFor(discoverProjectConfig(dir));
  } catch (error) {
    handleError(error, fmt);
  }
  requireAuth(creds, fmt);
  requireSpace(creds, fmt);

  const explicitProjectNode = opts.tree ?? creds.tree;
  let slug: string | undefined;
  if (explicitProjectNode === undefined) {
    slug = opts.gitAware
      ? (await new ProjectRegistry().resolve(dir)).slug
      : normalizeProjectSlug(basename(dir));
  }

  // Destination is independent of source interpretation: an explicit `--tree`
  // or `.me` tree is the full project node, with no slug resolution needed.
  const projectNode =
    explicitProjectNode ??
    `${creds.treeRoot ?? DEFAULT_PRIVATE_TREE_ROOT}.${slug}`;
  const docsTree = `${projectNode}.${DOCS_NODE_NAME}`;

  const gitContext = opts.gitAware ? await detectGitContext(dir) : {};
  if (opts.gitAware && gitContext.gitRoot === undefined) {
    handleError(
      new Error("--git-aware requires dir to be inside a git repository"),
      fmt,
    );
  }
  const gitMode = gitContext.gitRoot !== undefined;

  // Refuse a subfolder import root in git mode (see subdirRootError) before
  // any discovery or writes.
  if (gitContext.gitRoot !== undefined) {
    const rootErr = subdirRootError(
      dir,
      gitContext.gitRoot,
      docsTree,
      opts.allowSubdirRoot,
    );
    if (rootErr !== undefined) {
      handleError(new Error(rootErr), fmt);
    }
  }

  const engine = buildMemoryClient(creds);
  const progress =
    fmt === "text" ? createProgressReporter(process.stderr) : undefined;
  progress?.start();
  const fail = (error: unknown): never => {
    progress?.stop();
    handleError(error, fmt, { creds, scope: "space" });
  };

  // Discovery (mode-specific), then the mode-agnostic include/exclude filter.
  let relPaths: string[] = [];
  let untracked: ReadonlySet<string> = new Set();
  let gitIgnoredDocsOnDisk: number | undefined;
  try {
    let candidates: string[];
    if (gitMode) {
      const listing = await listGitFiles(dir, {
        includeIgnored: opts.includeIgnored,
      });
      candidates = listing.files;
      untracked = listing.untracked;
    } else {
      candidates = await discoverPlainFiles(dir);
    }
    relPaths = filterDocPaths(candidates, opts.include, opts.exclude);
    if (gitMode && !opts.includeIgnored && relPaths.length === 0) {
      const onDisk = filterDocPaths(
        await discoverPlainFiles(dir),
        opts.include,
        opts.exclude,
      );
      if (onDisk.length > 0) gitIgnoredDocsOnDisk = onDisk.length;
    }
  } catch (error) {
    fail(error);
  }

  // Orchestrated non-prune runs (`me import ci` uses prune) can skip a repo
  // with no matching docs cleanly. Prune-enabled runs continue with an empty
  // keep-list so deleting/renaming the final doc removes stale rows too.
  if (opts.skipIfEmpty === true && relPaths.length === 0 && !opts.prune) {
    progress?.stop();
    const structured: DocsImportResult = {
      dir: opts.dir,
      tree: displayTreePath(docsTree),
      mode: gitMode ? "git" : "plain",
      skippedNoDocs: true,
      ...(gitIgnoredDocsOnDisk !== undefined ? { gitIgnoredDocsOnDisk } : {}),
      dryRun: opts.dryRun,
      filesScanned: 0,
      skippedEmpty: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      pruned: 0,
      prunedPaths: [],
      failed: 0,
      errors: [],
    };
    await output(structured, fmt, () => {
      clack.log.info("No matching docs — skipping the docs import");
      if (gitIgnoredDocsOnDisk !== undefined) {
        clack.log.warn(
          `${gitIgnoredDocsOnDisk} matching doc(s) exist on disk but are ignored by git; pass --include-ignored with --git-aware to include them`,
        );
      }
    });
    return;
  }

  // Git last-modified dates — one streamed log pass. Skipped when the clone
  // is shallow (every path would collapse to the shallow boundary — wrong
  // dates are worse than absent ones); --temporal-key still applies.
  // Untracked files are excluded from the walk targets: they have no commit
  // to be dated by, and an undatable target would keep the log walk running
  // to the root instead of stopping early.
  let shallow = false;
  let dates = new Map<string, string>();
  if (gitMode && opts.parseTemporal) {
    try {
      shallow = await isShallowRepository(dir);
      if (!shallow) {
        dates = await lastModifiedByPath(
          dir,
          new Set(relPaths.filter((p) => !untracked.has(p))),
        );
      }
    } catch (error) {
      fail(error);
    }
  }

  const ctx: DocsMemoryContext = {
    docsTree,
    temporalKey: opts.temporalKey,
    parseTemporal: opts.parseTemporal,
    usedNames: new Map(),
  };

  const planned: Array<{ payload: MemoryCreateParams }> = [];
  let skippedEmpty = 0;
  const errors: Array<{ source: string; error: string }> = [];

  for (const relPath of relPaths) {
    progress?.process(relPath);
    let raw: string;
    try {
      raw = await Bun.file(join(dir, relPath)).text();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push({ source: relPath, error: msg });
      continue;
    }
    const payload = buildDocMemory(relPath, raw, dates.get(relPath), ctx);
    if (payload === null) {
      skippedEmpty++;
      continue;
    }
    planned.push({ payload });
    if (opts.verbose && fmt === "text") {
      const line = `  ${displayTreePath(payload.tree)} / ${payload.name}`;
      if (progress) progress.log(line);
      else console.log(line);
    }
  }

  // Dedup on the (tree, name) idempotency key — defensive; the sorted walk
  // plus per-tree name registry already make these unique.
  const { unique } = dedupBy(
    planned,
    (p) => `${p.payload.tree}\u0000${p.payload.name}`,
  );

  let inserted = 0;
  let updated = 0;
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
      inserted = result.results.filter((r) => r.status === "inserted").length;
      updated = result.results.filter((r) => r.status === "updated").length;
      skipped = result.results.filter((r) => r.status === "skipped").length;
      for (const e of result.errors) {
        errors.push({
          source: `chunk ${e.chunkIndex} (${e.itemCount} items)`,
          error: e.error,
        });
      }
    }
  } catch (error) {
    fail(error);
  }

  // Prune: one set-based memory.deleteOrphansInTree call — delete importer-written
  // rows (meta.source "docs") under the docs root whose (tree, name) slot the
  // walk did not produce. Atomic and complete at any corpus size; with
  // --dry-run the same predicate returns the exact would-delete list.
  // Refusals (nothing deleted, exit 1): an empty walk — a wrong cwd or
  // over-narrowed include set must not read as "delete the whole corpus" —
  // and a keep-list too large for one request (it cannot be chunked: "not in
  // chunk₁" ∪ "not in chunk₂" deletes nearly everything).
  let prunedPaths: string[] = [];
  let pruneRefused: string | undefined;
  if (opts.prune) {
    if (unique.length === 0 && opts.skipIfEmpty !== true) {
      pruneRefused =
        "empty walk — a wrong directory or over-narrowed --include must not delete the whole corpus";
    } else {
      try {
        const keep = buildKeepList(unique);
        if (keepListBytes(keep) > PRUNE_KEEP_BYTES_BUDGET) {
          pruneRefused = `keep-list too large for one delete-orphans request (${unique.length} docs)`;
        } else {
          const res = await engine.memory.deleteOrphansInTree({
            root: docsTree,
            metaContains: { source: DOCS_META_SOURCE },
            keep,
            ...(opts.dryRun ? { dryRun: true } : {}),
          });
          prunedPaths = res.paths;
        }
      } catch (error) {
        fail(error);
      }
    }
  }
  progress?.stop();

  const failed = errors.length;
  const structured: DocsImportResult = {
    dir: opts.dir,
    tree: displayTreePath(docsTree),
    mode: gitMode ? "git" : "plain",
    ...(shallow ? { shallow } : {}),
    ...(gitIgnoredDocsOnDisk !== undefined ? { gitIgnoredDocsOnDisk } : {}),
    dryRun: opts.dryRun,
    filesScanned: relPaths.length,
    skippedEmpty,
    inserted,
    updated,
    skipped,
    pruned: prunedPaths.length,
    prunedPaths,
    ...(pruneRefused !== undefined ? { pruneRefused } : {}),
    failed,
    errors,
  };

  await output(structured, fmt, () => {
    if (shallow) {
      clack.log.warn(
        "Shallow clone: git last-modified dates dropped (history is truncated).",
      );
    }
    if (pruneRefused !== undefined) {
      clack.log.warn(`--prune refused: ${pruneRefused}. Nothing was deleted.`);
    }
    if (gitIgnoredDocsOnDisk !== undefined) {
      clack.log.warn(
        `${gitIgnoredDocsOnDisk} matching doc(s) exist on disk but are ignored by git; pass --include-ignored with --git-aware to include them`,
      );
    }
    if (opts.dryRun) {
      // No server classification without submitting — don't imply a
      // new/updated/unchanged split that was never computed.
      clack.log.success(
        `Would import ${inserted} of ${relPaths.length} scanned docs into ${structured.tree} ` +
          `(${structured.mode} mode)${failed > 0 ? `, ${failed} failed` : ""}`,
      );
    } else {
      clack.log.success(
        `Imported ${inserted} new, ${updated} updated, ${skipped} unchanged, ${failed} failed ` +
          `from ${relPaths.length} docs into ${structured.tree} (${structured.mode} mode)`,
      );
    }
    if (skippedEmpty > 0) {
      console.log(`  Skipped ${skippedEmpty} empty file(s)`);
    }
    if (opts.prune && pruneRefused === undefined) {
      const pverb = opts.dryRun ? "Would prune" : "Pruned";
      console.log(`  ${pverb} ${prunedPaths.length} stale doc(s)`);
      if (opts.verbose || opts.dryRun) {
        for (const p of prunedPaths) console.log(`    - ${p}`);
      }
    }
    for (const e of errors) {
      console.log(`    ✗ ${e.source}: ${e.error}`);
    }
  });

  if (failed > 0 && inserted + updated === 0) process.exit(2);
  if (failed > 0 || pruneRefused !== undefined) process.exit(1);
}

/** `me import docs` subcommand factory. */
export function createDocsImportCommand(): Command {
  return new Command("docs")
    .description("import a directory's markdown docs as memories")
    .argument("[dir]", "directory to import (default: cwd)")
    .option(
      "--tree <path>",
      `full project tree to place '${DOCS_NODE_NAME}' under, no slug appended (default: .me tree, else <tree_root ?? ${DEFAULT_PRIVATE_TREE_ROOT}>.<slug> — private)`,
    )
    .option(
      "--include <globs...>",
      `glob patterns to import, replacing the default set (${DEFAULT_DOC_PATTERNS.join(" ")})`,
    )
    .option(
      "--exclude <globs...>",
      "glob patterns to drop from the include set",
    )
    .option(
      "--temporal-key <key>",
      "frontmatter key parsed as the temporal start (falls back to git last-modified in --git-aware mode)",
    )
    .option(
      "--no-temporal",
      "no temporal and no date-seeded ids (also skips the --git-aware git log pass)",
    )
    .option(
      "--git-aware",
      "use git discovery, gitignore filtering, git dates, and repo-root safety",
    )
    .option(
      "--include-ignored",
      "with --git-aware, include ignored/generated files too",
    )
    .option(
      "--prune",
      "delete previously-imported docs absent from this walk (full-corpus runs only — a narrowed walk prunes everything outside it)",
    )
    .option(
      "--allow-subdir-root",
      "allow an import root below the repo toplevel (slots become subfolder-relative — prefer --include scoping from the root)",
    )
    .option(
      "--dry-run",
      "discover and report what would be imported without writing",
    )
    .option("-v, --verbose", "per-file progress output")
    .action(async (docsDirArg: string | undefined, opts, cmdRef) => {
      const globalOpts = cmdRef.optsWithGlobals();
      await runDocsImport(docsDirArg, opts, globalOpts);
    });
}
