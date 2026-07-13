/**
 * The RETIRED `me import git-hook` — a removed-command stub plus the
 * marker-based cleanup helper for hooks installed by older versions.
 *
 * The local post-commit hook imported whatever HEAD was: feature-branch and
 * rebased commits landed in the tree keyed by `(tree, sha)` forever, it ran
 * per-clone with the committing human's credentials, and it failed silently.
 * CI imports replaced it (`me project ci` scaffolds a GitHub workflow that
 * runs `me import ci` on push to the default branch — see
 * CI_IMPORT_DESIGN.md). Anyone who truly wants local-commit capture can put
 * `me import git >/dev/null 2>&1 &` in their own hook — the primitive stays.
 *
 * What remains here: already-installed hooks keep firing on every commit
 * until their managed block is deleted, so `me project ci` migrates them —
 * it detects the block by its markers and strips it once CI credentials are
 * in place. The stub's error names the same two options: run `me project
 * ci`, or delete the block by hand.
 */
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

const execFileAsync = promisify(execFile);

/** Markers delimiting the managed block older versions wrote. */
const HOOK_START = "# >>> memory-engine (managed by `me import git-hook`) >>>";
const HOOK_END = "# <<< memory-engine <<<";

const SHEBANG = "#!/bin/sh";

/**
 * Remove the managed block. Returns the remaining script, or null when
 * nothing but the shebang would remain (caller deletes the file).
 */
export function removeHookBlock(existing: string): string | null {
  const start = existing.indexOf(HOOK_START);
  if (start === -1) return existing;
  const endMarker = existing.indexOf(HOOK_END, start);
  const end = endMarker === -1 ? existing.length : endMarker + HOOK_END.length;
  const tail = existing[end] === "\n" ? end + 1 : end;
  const remaining = existing.slice(0, start) + existing.slice(tail);
  const meaningful = remaining
    .split("\n")
    .filter((l) => l.trim().length > 0 && l.trim() !== SHEBANG);
  return meaningful.length === 0 ? null : remaining;
}

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      timeout: 5000,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The effective post-commit path (worktree-aware via --git-path). */
async function resolveHooksFile(root: string): Promise<string> {
  const hooksDir =
    (await git(root, ["rev-parse", "--git-path", "hooks"])) ?? "";
  const abs = isAbsolute(hooksDir) ? hooksDir : join(root, hooksDir);
  return join(abs, "post-commit");
}

/**
 * The hook file containing an installed managed block for the repo at `cwd`,
 * or undefined when there is none (not a repo, no hook, no block).
 */
export async function installedHookFile(
  cwd: string,
): Promise<string | undefined> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return undefined;
  const hooksFile = await resolveHooksFile(root);
  try {
    const existing = await readFile(hooksFile, "utf8");
    return existing.includes(HOOK_START) ? hooksFile : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strip the managed block from `hooksFile` (deleting the file when the block
 * was its only content). Idempotent — a missing block is a no-op.
 */
export async function stripHookBlock(hooksFile: string): Promise<void> {
  let existing: string;
  try {
    existing = await readFile(hooksFile, "utf8");
  } catch {
    return;
  }
  const remaining = removeHookBlock(existing);
  if (remaining === existing) return;
  if (remaining === null) await rm(hooksFile);
  else await writeFile(hooksFile, remaining);
}

/**
 * The removed-command stub (the `createRemovedCommand` pattern, cf. the
 * retired `me claude init`): accepts any of the old flags without Commander's
 * parse-time rejection so this message is what actually prints.
 */
export function createRemovedGitHookCommand(): Command {
  return new Command("git-hook")
    .description("removed — CI imports replaced the local hook")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(
        "error: 'me import git-hook' has been removed — a local hook imports unmerged and rebased " +
          "commits, and imports now run from CI on push to the default branch instead. Run " +
          "'me project ci' to set that up (it also strips an installed hook block), or delete the " +
          "'>>> memory-engine' block from .git/hooks/post-commit by hand.",
      );
      process.exit(1);
    });
}
