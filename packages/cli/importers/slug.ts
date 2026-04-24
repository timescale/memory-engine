/**
 * Project slug derivation for agent conversation imports.
 *
 * A "slug" is an ltree-safe label derived from the session's cwd:
 * - Prefer the git repo root directory name if the cwd is inside a repo.
 * - Fall back to `basename(cwd)`.
 * - Normalize to `[a-z0-9_]+`.
 *
 * Slug collisions (different cwds that normalize to the same label) are
 * resolved by appending a 4-char hash suffix of the git remote URL (if
 * available) or the full cwd otherwise. The first-seen slug keeps the
 * plain label; subsequent collisions get suffixes.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resolved project context derived from a cwd. */
export interface ProjectContext {
  /** ltree-safe slug, may include collision-resolution suffix. */
  slug: string;
  /** Canonical raw slug before any collision suffix. */
  baseSlug: string;
  /** The cwd that produced this slug (absolute, as given). */
  cwd: string;
  /** Detected git repo root (absolute path), if any. */
  gitRoot?: string;
  /** Git remote URL (first matching `origin` or fetch URL), if any. */
  gitRemote?: string;
}

const UNKNOWN_SLUG = "unknown";

/**
 * Normalize an arbitrary label to a valid ltree label.
 *
 * Rules (per docs/concepts.md): lowercase alphanumeric with underscores,
 * no leading digit ambiguity (prefix numeric-only labels with `_` to keep
 * them readable as identifiers).
 */
export function normalizeSlug(raw: string): string {
  const lowered = raw.toLowerCase();
  // Replace non-alphanumeric with underscore.
  const replaced = lowered.replace(/[^a-z0-9]+/g, "_");
  // Collapse runs of underscores and trim edges.
  const collapsed = replaced.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (collapsed.length === 0) return UNKNOWN_SLUG;
  // Purely numeric is legal for ltree, but not useful as a label.
  if (/^\d+$/.test(collapsed)) return `p_${collapsed}`;
  return collapsed;
}

/**
 * Detect the git top-level directory for `cwd`, if any.
 *
 * Returns `undefined` if `cwd` isn't in a git repo or if the lookup fails.
 * Uses a short timeout to avoid hanging on pathological cases.
 *
 * Async to avoid blocking the event loop (and the progress spinner) while
 * forking `git`. Thousands of cwds in a single import run meant thousands
 * of stalls under the previous `execSync` implementation.
 */
async function detectGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 2000, encoding: "utf8" },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect the `origin` fetch URL for a git repo at `root`, if any.
 */
async function detectGitRemote(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: root, timeout: 2000, encoding: "utf8" },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cache of in-flight/completed git-info lookups keyed by absolute path.
 * Storing the promise (not the result) coalesces concurrent lookups for
 * the same cwd — a common case when a tool has many sessions per project.
 */
const gitInfoCache = new Map<
  string,
  Promise<{ gitRoot?: string; gitRemote?: string }>
>();

function getGitInfo(
  cwd: string,
): Promise<{ gitRoot?: string; gitRemote?: string }> {
  const cached = gitInfoCache.get(cwd);
  if (cached) return cached;
  const pending = (async () => {
    const gitRoot = await detectGitRoot(cwd);
    const gitRemote = gitRoot ? await detectGitRemote(gitRoot) : undefined;
    return { gitRoot, gitRemote };
  })();
  gitInfoCache.set(cwd, pending);
  return pending;
}

/**
 * Short hex hash (4 chars) of an arbitrary disambiguation string.
 */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 4);
}

/**
 * Registry used to track slug assignments across a single import run so
 * colliding base slugs from different projects get distinct suffixes.
 */
export class SlugRegistry {
  /** Map of base slug → list of (cwd, assignedSlug) entries seen so far. */
  private readonly assignments = new Map<
    string,
    Array<{ cwd: string; assigned: string }>
  >();

  /**
   * Resolve the final slug for a cwd, registering the assignment.
   * Safe to call multiple times with the same cwd (returns the cached slug).
   *
   * If `cwd` is undefined/empty, returns the `unknown` slug so sessions
   * without a project context still get a home in the tree.
   */
  async resolve(cwd?: string): Promise<ProjectContext> {
    if (!cwd || cwd.trim().length === 0) {
      return { slug: UNKNOWN_SLUG, baseSlug: UNKNOWN_SLUG, cwd: "" };
    }

    const { gitRoot, gitRemote } = await getGitInfo(cwd);
    const source = gitRoot ?? cwd;
    const baseSlug = normalizeSlug(basename(source));

    const bucket = this.assignments.get(baseSlug) ?? [];

    // If this cwd already mapped to the same effective project, reuse.
    const canonicalKey = gitRoot ?? cwd;
    const existing = bucket.find((entry) => entry.cwd === canonicalKey);
    if (existing) {
      return {
        slug: existing.assigned,
        baseSlug,
        cwd,
        gitRoot,
        gitRemote,
      };
    }

    // First time we see this baseSlug → use plain baseSlug.
    // Subsequent distinct cwds → append hash suffix for disambiguation.
    let assigned: string;
    if (bucket.length === 0) {
      assigned = baseSlug;
    } else {
      // Disambiguate by git remote (stable across clones) or cwd (fallback).
      const salt = gitRemote ?? canonicalKey;
      assigned = `${baseSlug}_${shortHash(salt)}`;
    }

    bucket.push({ cwd: canonicalKey, assigned });
    this.assignments.set(baseSlug, bucket);

    return { slug: assigned, baseSlug, cwd, gitRoot, gitRemote };
  }

  /**
   * Return a summary of any collisions detected during the run.
   * Useful for verbose-mode diagnostics.
   */
  collisions(): Array<{ baseSlug: string; cwds: string[] }> {
    const out: Array<{ baseSlug: string; cwds: string[] }> = [];
    for (const [baseSlug, bucket] of this.assignments) {
      if (bucket.length > 1) {
        out.push({ baseSlug, cwds: bucket.map((e) => e.cwd) });
      }
    }
    return out;
  }
}
