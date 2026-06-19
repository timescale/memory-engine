/**
 * Git history importer — walks `git log` and turns each commit into one
 * memory under `<tree-root>.<project_slug>.git_history`.
 *
 * Identity: a deterministic UUIDv7 keyed by `git:<tree>:<sha>` with the
 * commit date as the timestamp half, so re-imports collide server-side
 * (`ON CONFLICT (id) DO NOTHING`) and become no-op skips — no cursor or
 * client-side state. Incremental runs (see commands/import-git.ts) only
 * narrow the walk; correctness never depends on them.
 *
 * The walk is one streamed `git log` invocation with NUL-separated fields:
 *
 *   %x01 %H %x00 %an %x00 %ae %x00 %aI %x00 %cI %x00 %P %x00 %B %x00
 *
 * followed by `--numstat` lines until the next record. Git forbids NUL in
 * commit messages, so the field splits are unambiguous; records are anchored
 * by `\x01` + 40-hex sha + NUL so a `\x01` inside a message body can't start
 * a record. Output is streamed through an incremental parser, so repos of
 * any size walk in constant memory.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { uuidv7At } from "./uuid.ts";

const execFileAsync = promisify(execFile);

/** Per-project tree node holding imported commits (next to agent_sessions). */
export const GIT_HISTORY_NODE_NAME = "git_history";

/**
 * Version tag stored in `meta.importer_version`. Reserved for a future
 * re-render path (cf. IMPORTER_VERSION in importers/index.ts); for now a
 * bump only marks newly-written records.
 */
export const GIT_IMPORTER_VERSION = "1";

/** Max file lines rendered into a commit memory's `Files:` block. */
export const FILE_LIST_CAP = 50;

/** Max body bytes rendered into a commit memory before truncation. */
export const BODY_BYTES_CAP = 64 * 1024;

/** One changed file from a `--numstat` line. */
export interface GitFileChange {
  /** Path as git prints it (renames keep the `{old => new}` form). */
  path: string;
  /** Added lines, or null for binary files. */
  insertions: number | null;
  /** Deleted lines, or null for binary files. */
  deletions: number | null;
}

/** One parsed commit from the log walk. */
export interface GitCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 author date (%aI). */
  authorDate: string;
  /** ISO 8601 committer date (%cI). */
  commitDate: string;
  /** Parent shas; length >= 2 marks a merge commit. */
  parents: string[];
  /** First line of the message. */
  subject: string;
  /** Message after the subject (trimmed; may be empty). */
  body: string;
  files: GitFileChange[];
}

/** Record start marker + the number of NUL-separated fields before the tail. */
const RECORD_START = "\x01";
const FIELD_COUNT = 7;
/** `\x01` + 40-hex sha + NUL — what a genuine record header looks like. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the log wire format uses \x01/\x00 separators by design
const RECORD_HEADER_RE = /^\x01[0-9a-f]{40}\x00/;
/** A `--numstat` line: added/deleted counts (or `-` for binary) + path. */
const NUMSTAT_LINE_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/**
 * Incremental parser for the custom `git log` format above. Feed decoded
 * stdout text via `push` (returns the records completed by that chunk) and
 * call `end` for the final record. Pure — unit-testable without git.
 */
export class GitLogParser {
  private buf = "";

  push(text: string): GitCommit[] {
    this.buf += text;
    const out: GitCommit[] = [];
    // A record is complete once the NEXT record's header is visible.
    for (;;) {
      const next = findNextHeader(this.buf, 1);
      if (next === -1) break;
      out.push(parseRecord(this.buf.slice(0, next)));
      this.buf = this.buf.slice(next);
    }
    return out;
  }

  end(): GitCommit[] {
    const rest = this.buf;
    this.buf = "";
    if (rest.trim().length === 0) return [];
    return [parseRecord(rest)];
  }
}

/** Find the next genuine record header at or after `from` (-1 if none). */
function findNextHeader(buf: string, from: number): number {
  let i = from;
  for (;;) {
    const at = buf.indexOf(RECORD_START, i);
    if (at === -1) return -1;
    if (RECORD_HEADER_RE.test(buf.slice(at, at + 42))) return at;
    i = at + 1;
  }
}

/** Parse one complete record (from its `\x01` up to the next header). */
function parseRecord(record: string): GitCommit {
  if (!RECORD_HEADER_RE.test(record.slice(0, 42))) {
    throw new Error(
      `malformed git log record: ${JSON.stringify(record.slice(0, 60))}`,
    );
  }
  // Split off the 7 NUL-separated fields; the remainder is the numstat tail.
  const parts = record.slice(1).split("\x00");
  if (parts.length < FIELD_COUNT + 1) {
    throw new Error(
      `malformed git log record for ${parts[0]}: expected ${FIELD_COUNT} fields`,
    );
  }
  const [sha, authorName, authorEmail, authorDate, commitDate, parentsRaw] =
    parts;
  // The body is everything between the 6th NUL and the 7th — but a body
  // cannot contain NUL, so it is exactly parts[6].
  const bodyRaw = parts[6] ?? "";
  const tail = parts.slice(FIELD_COUNT).join("\x00");

  const files: GitFileChange[] = [];
  for (const line of tail.split("\n")) {
    const m = NUMSTAT_LINE_RE.exec(line);
    if (!m) continue;
    const [, ins, del, path] = m;
    files.push({
      path: path ?? "",
      insertions: ins === "-" ? null : Number(ins),
      deletions: del === "-" ? null : Number(del),
    });
  }

  const message = bodyRaw.replace(/\r\n/g, "\n").trimEnd();
  const nl = message.indexOf("\n");
  const subject = (nl === -1 ? message : message.slice(0, nl)).trim();
  const body = nl === -1 ? "" : message.slice(nl + 1).trim();

  return {
    sha: sha ?? "",
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    authorDate: authorDate ?? "",
    commitDate: commitDate ?? "",
    parents: (parentsRaw ?? "").split(" ").filter((p) => p.length > 0),
    subject,
    body,
    files,
  };
}

/** Options narrowing the `git log` walk. */
export interface GitLogOptions {
  /** Rev to walk (default HEAD). Ignored when `range` is set. */
  rev?: string;
  /** Explicit rev range (e.g. `<sha>..HEAD`) for incremental walks. */
  range?: string;
  /** Only commits at/after this date (passed to `git log --since`). */
  since?: string;
  /** Only commits at/before this date (passed to `git log --until`). */
  until?: string;
  /** Cap on walked commits (`git log --max-count`). */
  maxCount?: number;
  /** Drop all merge commits in git itself (`git log --no-merges`). */
  noMerges?: boolean;
}

/**
 * Stream the commit log of the repo at `repoRoot`, newest first.
 *
 * An empty repo (no commits on the rev) yields nothing rather than failing,
 * so `me claude init` is safe on fresh repos.
 */
export async function* walkGitLog(
  repoRoot: string,
  options: GitLogOptions = {},
): AsyncIterable<GitCommit> {
  const args = [
    "-C",
    repoRoot,
    "log",
    "--encoding=UTF-8",
    "--numstat",
    "--pretty=format:%x01%H%x00%an%x00%ae%x00%aI%x00%cI%x00%P%x00%B%x00",
  ];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.until) args.push(`--until=${options.until}`);
  if (options.maxCount !== undefined)
    args.push(`--max-count=${options.maxCount}`);
  if (options.noMerges) args.push("--no-merges");
  args.push(options.range ?? options.rev ?? "HEAD");
  args.push("--");

  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain stderr concurrently so a chatty git can't fill the pipe and stall.
  const stderrText = new Response(proc.stderr).text();

  const parser = new GitLogParser();
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of proc.stdout) {
    yield* parser.push(decoder.decode(chunk, { stream: true }));
  }
  const final = decoder.decode();
  if (final.length > 0) yield* parser.push(final);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await stderrText;
    // A rev with no commits yet (fresh repo) is "nothing to import", not an
    // error. Git phrases this a few ways depending on version/state.
    if (/does not have any commits|unknown revision.*HEAD/i.test(stderr)) {
      return;
    }
    throw new Error(`git log failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  yield* parser.end();
}

/**
 * True when `sha` is an ancestor of `rev` in the repo at `repoRoot`. Any
 * failure (unknown sha after a force-push, detached state, …) is false —
 * callers fall back to a full walk, which deterministic ids make safe.
 */
export async function isAncestor(
  repoRoot: string,
  sha: string,
  rev: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", repoRoot, "merge-base", "--is-ancestor", sha, rev],
      { timeout: 5000, encoding: "utf8" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a merge commit is skipped, or null to import it.
 *
 * Default policy: keep merges that carry a message body (GitHub PR merges
 * put the PR title there) and drop subject-only boilerplate
 * (`Merge branch 'x' into y`). `--no-merges` drops them all — that case is
 * filtered by git itself (see walkGitLog), so it never reaches here.
 */
export function mergeSkipReason(commit: GitCommit): string | null {
  if (commit.parents.length < 2) return null;
  return commit.body.length === 0 ? "merge_boilerplate" : null;
}

/** Context shared by every memory built in one import run. */
export interface CommitMemoryContext {
  /** Full target tree (e.g. `share.projects.foo.git_history`). */
  tree: string;
  /** Project slug the tree was derived from. */
  projectSlug: string;
  /** Git remote URL, if the repo has one. */
  gitRemote?: string;
  /** Render the changed-file list into the content. */
  fileList: boolean;
}

/**
 * Build the memory payload for one commit, or an error string when the
 * commit has an unusable date. Content is the message plus a capped file
 * list; everything queryable lives in meta; temporal is the commit date.
 */
export function buildCommitMemory(
  commit: GitCommit,
  ctx: CommitMemoryContext,
): MemoryCreateParams | { error: string } {
  const commitMs = Date.parse(commit.commitDate);
  if (Number.isNaN(commitMs)) {
    return { error: `invalid commit date: ${commit.commitDate}` };
  }

  // Idempotency is keyed on (tree, name) where name is the commit sha; the id
  // is a timestamp-prefixed v7 (random tail) so commits sort by date on the id.
  const id = uuidv7At(commitMs);

  let content = commit.subject;
  const body = truncateUtf8(commit.body, BODY_BYTES_CAP);
  if (body.length > 0) content += `\n\n${body}`;
  if (ctx.fileList && commit.files.length > 0) {
    const lines = commit.files
      .slice(0, FILE_LIST_CAP)
      .map((f) =>
        f.insertions === null || f.deletions === null
          ? `  ${f.path} (binary)`
          : `  ${f.path} (+${f.insertions} -${f.deletions})`,
      );
    if (commit.files.length > FILE_LIST_CAP) {
      lines.push(`  … and ${commit.files.length - FILE_LIST_CAP} more files`);
    }
    content += `\n\nFiles:\n${lines.join("\n")}`;
  }

  const insertions = commit.files.reduce(
    (sum, f) => sum + (f.insertions ?? 0),
    0,
  );
  const deletions = commit.files.reduce(
    (sum, f) => sum + (f.deletions ?? 0),
    0,
  );

  const meta: Record<string, unknown> = {
    type: "git_commit",
    sha: commit.sha,
    source_project_slug: ctx.projectSlug,
    author_name: commit.authorName,
    author_email: commit.authorEmail,
    author_date: commit.authorDate,
    commit_date: commit.commitDate,
    files_changed: commit.files.length,
    insertions,
    deletions,
    importer_version: GIT_IMPORTER_VERSION,
  };
  if (ctx.gitRemote) meta.source_git_repo = ctx.gitRemote;
  if (commit.parents.length >= 2) meta.is_merge = true;

  return {
    id,
    name: commit.sha,
    content,
    meta,
    tree: ctx.tree,
    temporal: { start: new Date(commitMs).toISOString() },
  };
}

/** Truncate to a UTF-8 byte budget on a char boundary, marking the cut. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    // Shrink geometrically instead of stepping one char at a time.
    end = Math.min(end - 1, Math.floor(end * 0.9));
  }
  // Don't cut a surrogate pair in half.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}\n…[truncated]`;
}
