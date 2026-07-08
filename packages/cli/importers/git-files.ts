/**
 * Git-backed file discovery for `me import docs`.
 *
 * The docs importer treats git as an *enhancer*, not a requirement: when the
 * import root is inside a work tree, discovery comes from `git ls-files`
 * (tracked + untracked-but-not-ignored, so gitignore keeps build output out
 * and a just-written doc still imports) and each file's temporal comes from
 * its last-modified commit. All helpers here answer relative to an arbitrary
 * directory *inside* the repo — the import root — never the repo toplevel:
 * `ls-files` is cwd-scoped and `log --relative` rebases diff paths, so
 * callers only ever see paths relative to the import root.
 *
 * Mode detection (is this a work tree at all?) happens upstream via
 * SlugRegistry's gitRoot, so these helpers are only called inside a repo;
 * isShallowRepository alone degrades to false on any failure, since its
 * answer gates dropping data (git dates) rather than an operation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** ls-files output cap — a repo listing bigger than this is not a docs dir. */
const LS_FILES_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Cap on explicit pathspecs handed to the `git log` walk. Under it we pass
 * the discovered doc paths themselves so git skips unrelated commits; over
 * it (or with no target list) the walk runs unfiltered and relies on the
 * early-stop in `lastModifiedByPath`. Keeps the argv well under platform
 * command-line limits.
 */
const MAX_LOG_PATHSPECS = 1000;

/**
 * True when the repo containing `dir` is a shallow clone. Shallow history
 * collapses every path's "last commit" to the shallow boundary, so callers
 * drop git-derived dates rather than store wrong ones.
 */
export async function isShallowRepository(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "--is-shallow-repository"],
      { timeout: 5000, encoding: "utf8" },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** One ls-files pass: every discoverable file + which of them are untracked. */
export interface GitFileListing {
  /** Tracked plus untracked-but-not-ignored paths, relative to `dir`, sorted. */
  files: string[];
  /**
   * The untracked subset — paths with no commit history, so callers exclude
   * them from the last-modified walk (they can never be dated, and waiting
   * for them would defeat its early stop).
   */
  untracked: Set<string>;
}

/**
 * List files under `dir` (paths relative to `dir`, sorted): tracked plus
 * untracked-but-not-ignored — `git ls-files -t --cached --others
 * --exclude-standard`, one spawn; `-t` tags each entry (`H` cached /
 * `?` other) so the untracked subset comes out of the same pass. `-z`
 * output, so exotic filenames arrive unquoted. Tracked-only would silently
 * skip a doc someone wrote but hasn't committed; `--exclude-standard`
 * still keeps gitignored build output away.
 */
export async function listGitFiles(dir: string): Promise<GitFileListing> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      dir,
      "ls-files",
      "-z",
      "-t",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { timeout: 60_000, encoding: "utf8", maxBuffer: LS_FILES_MAX_BUFFER },
  );
  const files: string[] = [];
  const untracked = new Set<string>();
  for (const entry of stdout.split("\0")) {
    // Each record is `<tag> <path>` — H = cached (tracked), ? = other.
    if (entry.length < 3) continue;
    const tag = entry[0];
    const path = entry.slice(2);
    files.push(path);
    if (tag === "?") untracked.add(path);
  }
  files.sort();
  return { files, untracked };
}

/**
 * Map each path (relative to `dir`) to the ISO author date of the newest
 * commit touching it, in ONE streamed `git log` pass — never a per-file
 * `git log -1` spawn. Newest-first, so the first sighting of a path wins;
 * the subprocess is killed early once every `target` path has a date.
 * Callers must therefore pass only paths that CAN be dated — exclude the
 * untracked subset from {@link listGitFiles} (a target with no commit
 * history keeps the walk running to the root; a just-staged never-committed
 * file is a residual case of the same, rare enough to accept).
 *
 * Paths print relative to `dir` (`--relative` with `-C`), unquoted
 * (`core.quotepath=false`). Merge commits list no files under plain
 * `--name-only`, so a file only touched by a merge is dated at the
 * underlying non-merge commit. A renamed file is dated at the rename
 * commit (the rename created its current path).
 */
export async function lastModifiedByPath(
  dir: string,
  targets: Set<string>,
): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  if (targets.size === 0) return dates;

  const args = [
    "-c",
    "core.quotepath=false",
    "-C",
    dir,
    "log",
    "--relative",
    "--name-only",
    "--format=%x01%aI",
  ];
  if (targets.size <= MAX_LOG_PATHSPECS) {
    args.push("--", ...targets);
  }

  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain stderr concurrently so a chatty git can't fill the pipe and stall.
  const stderrText = new Response(proc.stderr).text();

  const remaining = new Set(targets);
  let killed = false;
  let currentDate = "";
  let buf = "";

  const takeLine = (line: string) => {
    if (line.startsWith("\x01")) {
      currentDate = line.slice(1).trim();
      return;
    }
    const path = line.trim();
    if (path.length === 0 || currentDate.length === 0) return;
    if (remaining.delete(path)) {
      dates.set(path, currentDate);
    }
  };

  const decoder = new TextDecoder("utf-8");
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      takeLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
    if (remaining.size === 0) {
      killed = true;
      proc.kill();
      break;
    }
  }
  if (!killed) {
    buf += decoder.decode();
    if (buf.length > 0) takeLine(buf);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !killed) {
    const stderr = await stderrText;
    // A repo with no commits yet has no dates to offer — not an error.
    if (/does not have any commits|unknown revision/i.test(stderr)) {
      return dates;
    }
    throw new Error(`git log failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return dates;
}
