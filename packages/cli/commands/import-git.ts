/**
 * `me import git` — import a repo's commit history as memories.
 *
 * One memory per commit (message + capped changed-file list) under
 * `<project-tree>.git_history` — the full project tree from `--project-tree` or
 * the repo's `.me`, else `<DEFAULT_TREE_ROOT>.<project_slug>` — named with the
 * commit `<sha>` and with the commit date as the memory's temporal. `me import
 * git` is single-repo, so the tree is a full node (no slug appended here).
 * Idempotency is keyed on
 * `(tree, sha)`, so re-runs become server-side skips; the id is a
 * timestamp-prefixed UUIDv7 (random tail) so commits sort by date on the id.
 *
 * Re-runs are also incremental: the newest already-imported commit is looked
 * up server-side (one search) and, when it is an ancestor of the target rev,
 * only `<sha>..<rev>` is walked. Any doubt (force-push, other branch,
 * explicit bounds) falls back to the full walk, which the (tree, sha) key
 * makes safe. `--full` forces the full walk.
 */
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { Command, InvalidArgumentError } from "commander";
import { batchCreateChunked } from "../chunk.ts";
import type { MemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import {
  buildCommitMemory,
  GIT_HISTORY_NODE_NAME,
  isAncestor,
  mergeSkipReason,
  walkGitLog,
} from "../importers/git.ts";
import {
  createProgressReporter,
  DEFAULT_TREE_ROOT,
  dedupBy,
} from "../importers/index.ts";
import { SlugRegistry } from "../importers/slug.ts";
import { getOutputFormat, output } from "../output.ts";
import {
  buildMemoryClient,
  handleError,
  requireAuth,
  requireSpace,
} from "../util.ts";
import { VALID_TREE_ROOT_RE } from "./import.ts";

/** Parsed options for one git import run. */
export interface GitImportOptions {
  /** Repo path (any directory inside the repo). Default: cwd. */
  repo?: string;
  /** Rev to walk (branch, tag, sha). Default: HEAD. */
  branch?: string;
  /** `git log --since` bound (git accepts ISO or approxidate). */
  since?: string;
  /** `git log --until` bound. */
  until?: string;
  /** Cap on walked commits. */
  maxCount?: number;
  /** Force the full walk (skip the incremental high-water lookup). */
  full?: boolean;
  /** False (via --no-merges) drops all merge commits. */
  merges?: boolean;
  /** False (via --no-file-list) omits the changed-file list from content. */
  fileList?: boolean;
  /**
   * The full project tree to place `git_history` under (no slug appended). From
   * `--project-tree`; when unset, runGitImport falls back to the repo's `.me`
   * tree, else `<DEFAULT_TREE_ROOT>.<slug>`.
   */
  projectTree?: string;
  /** Report without writing. */
  dryRun?: boolean;
  /** Per-commit progress output. */
  verbose?: boolean;
  /**
   * Soft-skip (info, success) when the target isn't a git repo — used by
   * `me claude init`, which runs in arbitrary directories.
   */
  skipIfNotRepo?: boolean;
}

/** Validate raw Commander opts into a typed option set. */
export function buildGitImportOptions(
  opts: Record<string, unknown>,
  repoArg?: string,
): GitImportOptions {
  const projectTree =
    typeof opts.projectTree === "string" ? opts.projectTree : undefined;
  if (projectTree !== undefined && !VALID_TREE_ROOT_RE.test(projectTree)) {
    throw new Error(
      `Invalid --project-tree: '${projectTree}'. Use ltree labels ([A-Za-z0-9_-]) separated by '.' or '/', with an optional leading '~' for your home.`,
    );
  }
  return {
    repo: repoArg,
    branch: typeof opts.branch === "string" ? opts.branch : undefined,
    since: typeof opts.since === "string" ? opts.since : undefined,
    until: typeof opts.until === "string" ? opts.until : undefined,
    maxCount: typeof opts.maxCount === "number" ? opts.maxCount : undefined,
    full: opts.full === true,
    merges: opts.merges !== false,
    fileList: opts.fileList !== false,
    projectTree,
    dryRun: opts.dryRun === true,
    verbose: opts.verbose === true,
    skipIfNotRepo: opts.skipIfNotRepo === true,
  };
}

/** Structured result of one run (also the --json/--yaml output shape). */
interface GitImportResult {
  repo: string;
  remote?: string;
  tree: string;
  rev: string;
  /** The incremental range actually walked, when one was used. */
  range?: string;
  dryRun: boolean;
  commitsWalked: number;
  inserted: number;
  /** Already present server-side (idempotent re-import). */
  skipped: number;
  /** Merge commits dropped by the boilerplate rule. */
  skippedMerges: number;
  failed: number;
  errors: Array<{ sha: string; error: string }>;
}

/**
 * Newest already-imported commit sha under `tree`, or null. Unranked search
 * returns newest-first by id, and git ids encode the commit date — so one
 * `limit: 1` search yields the high-water commit.
 */
async function searchHighWaterSha(
  engine: MemoryClient,
  tree: string,
): Promise<string | null> {
  const res = await engine.memory.search({
    tree,
    meta: { type: "git_commit" },
    limit: 1,
  });
  const sha = res.results[0]?.meta.sha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Run one git history import end-to-end and render the outcome. Exported so
 * `me claude init` can run it as a setup step, reusing the same
 * auth/option/render path as the standalone `me import git`.
 */
export async function runGitImport(
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
  repoArg?: string,
): Promise<void> {
  const creds = resolveCredentials(
    typeof globalOpts.server === "string" ? globalOpts.server : undefined,
  );
  const fmt = getOutputFormat(globalOpts);
  requireAuth(creds, fmt);
  requireSpace(creds, fmt);

  let opts: GitImportOptions;
  try {
    opts = buildGitImportOptions(rawOpts, repoArg);
  } catch (error) {
    handleError(error, fmt);
  }

  const repoPath = resolve(opts.repo ?? process.cwd());
  const { slug, gitRoot, gitRemote } = await new SlugRegistry().resolve(
    repoPath,
  );
  if (!gitRoot) {
    if (opts.skipIfNotRepo) {
      if (fmt === "text") {
        clack.log.info(
          `${repoPath} is not a git repository — skipping git history import`,
        );
      }
      return;
    }
    handleError(new Error(`${repoPath} is not a git repository`), fmt);
  }

  // The full project node git history nests under (no slug appended — git import
  // is single-repo): an explicit `--project-tree`, else the repo's `.me` tree
  // (`creds.projectTree`, resolved through the standard precedence so it honors
  // `--config-dir`), else the default `<DEFAULT_TREE_ROOT>.<slug>`.
  const projectTree =
    opts.projectTree ?? creds.projectTree ?? `${DEFAULT_TREE_ROOT}.${slug}`;
  const tree = `${projectTree}.${GIT_HISTORY_NODE_NAME}`;
  const rev = opts.branch ?? "HEAD";
  const engine = buildMemoryClient(creds);

  // Incremental fast path: only when nothing narrows the walk explicitly.
  const explicitBounds =
    opts.full ||
    opts.since !== undefined ||
    opts.until !== undefined ||
    opts.maxCount !== undefined;
  let range: string | undefined;
  if (!explicitBounds) {
    try {
      const highWater = await searchHighWaterSha(engine, tree);
      if (highWater && (await isAncestor(gitRoot, highWater, rev))) {
        range = `${highWater}..${rev}`;
      }
    } catch (error) {
      handleError(error, fmt, { creds, scope: "space" });
    }
  }

  const progress =
    fmt === "text" ? createProgressReporter(process.stderr) : undefined;
  progress?.start();

  const planned: Array<{ memoryId: string; payload: MemoryCreateParams }> = [];
  let commitsWalked = 0;
  let skippedMerges = 0;
  let failed = 0;
  const errors: Array<{ sha: string; error: string }> = [];

  try {
    for await (const commit of walkGitLog(gitRoot, {
      rev,
      range,
      since: opts.since,
      until: opts.until,
      maxCount: opts.maxCount,
      noMerges: opts.merges === false,
    })) {
      commitsWalked++;
      progress?.process(`${commit.sha.slice(0, 8)} ${commit.subject}`);
      if (mergeSkipReason(commit) !== null) {
        skippedMerges++;
        continue;
      }
      const built = buildCommitMemory(commit, {
        tree,
        projectSlug: slug,
        gitRemote,
        fileList: opts.fileList !== false,
      });
      if ("error" in built) {
        failed++;
        errors.push({ sha: commit.sha, error: built.error });
        continue;
      }
      planned.push({ memoryId: built.id as string, payload: built });
      if (opts.verbose && fmt === "text") {
        const line = `  ${commit.sha.slice(0, 8)} ${commit.subject}`;
        if (progress) progress.log(line);
        else console.log(line);
      }
    }
  } catch (error) {
    progress?.stop();
    handleError(error, fmt, { creds, scope: "space" });
  }

  // Dedup on the commit sha (the (tree, name) key), not the random id.
  const { unique } = dedupBy(planned, (p) => p.payload.name ?? p.memoryId);

  let inserted = 0;
  let skipped = 0;
  if (opts.dryRun) {
    inserted = unique.length;
  } else if (unique.length > 0) {
    // Re-import is idempotent via content-aware replace: an unchanged commit is
    // a no-op (status 'skipped'); a version bump changes meta and re-renders in
    // place ('updated'). Without a directive a re-submitted commit would be a
    // hard (tree, name) conflict.
    const result = await batchCreateChunked(
      engine,
      unique.map((p) => p.payload),
      { onConflict: "replace" },
    );
    // A commit "imported" if it was inserted or re-rendered; skipped =
    // unchanged. 'error' rows are tallied via errors[] (failed) below.
    inserted = result.results.filter(
      (r) => r.status === "inserted" || r.status === "updated",
    ).length;
    skipped = result.results.filter((r) => r.status === "skipped").length;
    for (const e of result.errors) {
      failed += e.itemCount;
      errors.push({ sha: `chunk ${e.chunkIndex}`, error: e.error });
    }
  }
  progress?.stop();

  const structured: GitImportResult = {
    repo: gitRoot,
    remote: gitRemote,
    tree,
    rev,
    range,
    dryRun: opts.dryRun === true,
    commitsWalked,
    inserted,
    skipped,
    skippedMerges,
    failed,
    errors,
  };

  output(structured, fmt, () => {
    const verb = opts.dryRun ? "Would import" : "Imported";
    clack.log.success(
      `${verb} ${inserted} new, ${skipped} already present, ${failed} failed ` +
        `commits into ${tree}`,
    );
    if (range) console.log(`  Incremental walk: ${range}`);
    console.log(`  Walked ${commitsWalked} commits from ${gitRoot} (${rev})`);
    if (skippedMerges > 0) {
      console.log(`  Skipped ${skippedMerges} boilerplate merge commit(s)`);
    }
    for (const e of errors) {
      console.log(`    ✗ ${e.sha}: ${e.error}`);
    }
  });

  if (failed > 0 && inserted === 0) process.exit(2);
  if (failed > 0) process.exit(1);
}

/** Parse `--max-count` into a positive integer. */
function parseMaxCount(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
}

/** `me import git` subcommand factory. */
export function createGitImportCommand(): Command {
  return new Command("git")
    .description("import a repo's git commit history as memories")
    .argument("[repo]", "path inside the repo to import (default: cwd)")
    .option("--branch <rev>", "branch/tag/rev to walk (default: HEAD)")
    .option(
      "--since <date>",
      "only commits at/after this date (any format git accepts)",
    )
    .option("--until <date>", "only commits at/before this date")
    .option(
      "--max-count <n>",
      "import at most this many recent commits",
      parseMaxCount,
    )
    .option(
      "--full",
      "walk the full history (skip the incremental high-water lookup)",
    )
    .option("--no-merges", "drop all merge commits")
    .option("--no-file-list", "omit the changed-file list from commit memories")
    .option(
      "--project-tree <path>",
      `full project tree to place '${GIT_HISTORY_NODE_NAME}' under, no slug appended (default: the repo's .me tree, else ${DEFAULT_TREE_ROOT}.<slug>)`,
    )
    .option(
      "--dry-run",
      "parse and report what would be imported without writing",
    )
    .option("-v, --verbose", "per-commit progress output")
    .action(async (repoArg: string | undefined, opts, cmdRef) => {
      const globalOpts = cmdRef.optsWithGlobals();
      await runGitImport(opts, globalOpts, repoArg);
    });
}
