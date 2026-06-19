/**
 * Tests for the git history importer: the streaming `git log` parser and
 * the per-commit memory builder. Fixture strings mirror the byte layout
 * git actually emits for
 * `--numstat --pretty=format:%x01%H%x00…%B%x00` (verified empirically):
 *
 *   \x01<sha>\0<an>\0<ae>\0<aI>\0<cI>\0<parents>\0<body>\0\n<numstat>\n\n
 *
 * Merge commits emit no numstat lines; a root commit has an empty parents
 * field; the final record ends at EOF without trailing separators.
 */
import { describe, expect, test } from "bun:test";
import {
  BODY_BYTES_CAP,
  buildCommitMemory,
  type CommitMemoryContext,
  FILE_LIST_CAP,
  type GitCommit,
  GitLogParser,
  mergeSkipReason,
} from "./git.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

/** Build one raw log record in the observed wire layout. */
function rec(opts: {
  sha?: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: string;
  commitDate?: string;
  parents?: string;
  body?: string;
  numstat?: string[];
}): string {
  const fields = [
    opts.sha ?? SHA_A,
    opts.authorName ?? "Ada",
    opts.authorEmail ?? "ada@example.com",
    opts.authorDate ?? "2026-01-02T03:04:05+02:00",
    opts.commitDate ?? "2026-01-02T03:04:06+02:00",
    opts.parents ?? SHA_B,
    opts.body ?? "subject line\n",
  ].join("\x00");
  const tail =
    opts.numstat && opts.numstat.length > 0
      ? `\n${opts.numstat.join("\n")}\n\n`
      : "\n";
  return `\x01${fields}\x00${tail}`;
}

/** Parse a full log text in one push + end. */
function parseAll(text: string): GitCommit[] {
  const parser = new GitLogParser();
  return [...parser.push(text), ...parser.end()];
}

describe("GitLogParser", () => {
  test("parses a single commit with files", () => {
    const commits = parseAll(
      rec({
        body: "fix: a thing\n\nlonger explanation\nover two lines\n",
        numstat: ["10\t2\tsrc/a.ts", "0\t5\tsrc/b.ts"],
      }),
    );
    expect(commits).toHaveLength(1);
    const c = commits[0];
    expect(c?.sha).toBe(SHA_A);
    expect(c?.authorName).toBe("Ada");
    expect(c?.authorEmail).toBe("ada@example.com");
    expect(c?.authorDate).toBe("2026-01-02T03:04:05+02:00");
    expect(c?.commitDate).toBe("2026-01-02T03:04:06+02:00");
    expect(c?.parents).toEqual([SHA_B]);
    expect(c?.subject).toBe("fix: a thing");
    expect(c?.body).toBe("longer explanation\nover two lines");
    expect(c?.files).toEqual([
      { path: "src/a.ts", insertions: 10, deletions: 2 },
      { path: "src/b.ts", insertions: 0, deletions: 5 },
    ]);
  });

  test("parses multiple records, including a final record at EOF", () => {
    const commits = parseAll(
      rec({ sha: SHA_A, numstat: ["1\t0\ta.txt"] }) +
        rec({ sha: SHA_B, parents: "", body: "first\n" }),
    );
    expect(commits.map((c) => c.sha)).toEqual([SHA_A, SHA_B]);
    // Root commit: empty parents field → no parents.
    expect(commits[1]?.parents).toEqual([]);
  });

  test("merge commits carry two parents and no files", () => {
    const commits = parseAll(
      rec({ parents: `${SHA_B} ${SHA_C}`, body: "Merge branch 'x'\n" }),
    );
    expect(commits[0]?.parents).toEqual([SHA_B, SHA_C]);
    expect(commits[0]?.files).toEqual([]);
  });

  test("handles rename and binary numstat lines", () => {
    const commits = parseAll(
      rec({
        numstat: ["3\t1\tsrc/{old => new}/mod.ts", "-\t-\tassets/logo.png"],
      }),
    );
    expect(commits[0]?.files).toEqual([
      { path: "src/{old => new}/mod.ts", insertions: 3, deletions: 1 },
      { path: "assets/logo.png", insertions: null, deletions: null },
    ]);
  });

  test("a \\x01 inside a message body does not start a new record", () => {
    const commits = parseAll(
      rec({ sha: SHA_A, body: "subject\n\nweird \x01 control char\n" }) +
        rec({ sha: SHA_B }),
    );
    expect(commits).toHaveLength(2);
    expect(commits[0]?.body).toBe("weird \x01 control char");
  });

  test("reassembles records split across arbitrary chunk boundaries", () => {
    const full =
      rec({ sha: SHA_A, numstat: ["1\t0\ta.txt"] }) +
      rec({ sha: SHA_B, body: "two\n" }) +
      rec({ sha: SHA_C, parents: "", body: "three\n" });
    // Split mid-header, mid-field, and mid-numstat to stress the buffer.
    for (const chunkSize of [1, 7, 41, 64]) {
      const parser = new GitLogParser();
      const commits: GitCommit[] = [];
      for (let i = 0; i < full.length; i += chunkSize) {
        commits.push(...parser.push(full.slice(i, i + chunkSize)));
      }
      commits.push(...parser.end());
      expect(commits.map((c) => c.sha)).toEqual([SHA_A, SHA_B, SHA_C]);
    }
  });

  test("empty input yields nothing", () => {
    const parser = new GitLogParser();
    expect(parser.push("")).toEqual([]);
    expect(parser.end()).toEqual([]);
  });

  test("throws on a malformed record", () => {
    expect(() => parseAll("\x01not-a-sha\x00rest")).toThrow(/malformed/);
  });
});

/** A parsed commit for builder tests. */
function commit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    sha: SHA_A,
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authorDate: "2026-01-02T03:04:05+02:00",
    commitDate: "2026-01-02T03:04:06+02:00",
    parents: [SHA_B],
    subject: "fix: a thing",
    body: "details here",
    files: [{ path: "src/a.ts", insertions: 10, deletions: 2 }],
    ...overrides,
  };
}

function ctx(
  overrides: Partial<CommitMemoryContext> = {},
): CommitMemoryContext {
  return {
    tree: "share.projects.demo.git_history",
    projectSlug: "demo",
    gitRemote: "git@github.com:org/demo.git",
    fileList: true,
    ...overrides,
  };
}

describe("buildCommitMemory", () => {
  test("builds content, meta, temporal, and a deterministic id", () => {
    const built = buildCommitMemory(commit(), ctx());
    if ("error" in built) throw new Error(built.error);
    expect(built.content).toBe(
      "fix: a thing\n\ndetails here\n\nFiles:\n  src/a.ts (+10 -2)",
    );
    expect(built.tree).toBe("share.projects.demo.git_history");
    // Commit date, normalized to UTC.
    expect(built.temporal).toEqual({ start: "2026-01-02T01:04:06.000Z" });
    expect(built.meta).toEqual({
      type: "git_commit",
      sha: SHA_A,
      source_project_slug: "demo",
      source_git_repo: "git@github.com:org/demo.git",
      author_name: "Ada",
      author_email: "ada@example.com",
      author_date: "2026-01-02T03:04:05+02:00",
      commit_date: "2026-01-02T03:04:06+02:00",
      files_changed: 1,
      insertions: 10,
      deletions: 2,
      importer_version: "1",
    });

    // Deterministic: same inputs → same id; different tree → different id.
    const again = buildCommitMemory(commit(), ctx());
    if ("error" in again) throw new Error(again.error);
    expect(again.id).toBe(built.id);
    const moved = buildCommitMemory(commit(), ctx({ tree: "share.other" }));
    if ("error" in moved) throw new Error(moved.error);
    expect(moved.id).not.toBe(built.id);
  });

  test("omits remote and merge marker when absent, sets them when present", () => {
    const plain = buildCommitMemory(commit(), ctx({ gitRemote: undefined }));
    if ("error" in plain) throw new Error(plain.error);
    expect(plain.meta).not.toContainKey("source_git_repo");
    expect(plain.meta).not.toContainKey("is_merge");

    const merge = buildCommitMemory(commit({ parents: [SHA_B, SHA_C] }), ctx());
    if ("error" in merge) throw new Error(merge.error);
    expect(merge.meta?.is_merge).toBe(true);
  });

  test("renders binary files and caps the file list", () => {
    const files = Array.from({ length: FILE_LIST_CAP + 3 }, (_, i) => ({
      path: `f${i}.ts`,
      insertions: 1,
      deletions: 0,
    }));
    files[0] = { path: "img.png", insertions: null, deletions: null } as never;
    const built = buildCommitMemory(commit({ files }), ctx());
    if ("error" in built) throw new Error(built.error);
    expect(built.content).toContain("  img.png (binary)");
    expect(built.content).toContain(`  … and 3 more files`);
    // Binary files don't contribute to line counts.
    expect(built.meta?.insertions).toBe(FILE_LIST_CAP + 2);
    expect(built.meta?.files_changed).toBe(FILE_LIST_CAP + 3);
  });

  test("omits the file list when disabled", () => {
    const built = buildCommitMemory(commit(), ctx({ fileList: false }));
    if ("error" in built) throw new Error(built.error);
    expect(built.content).toBe("fix: a thing\n\ndetails here");
  });

  test("truncates oversized bodies on a byte budget", () => {
    const built = buildCommitMemory(
      commit({ body: "x".repeat(BODY_BYTES_CAP + 1000), files: [] }),
      ctx(),
    );
    if ("error" in built) throw new Error(built.error);
    expect(built.content).toContain("…[truncated]");
    expect(Buffer.byteLength(built.content, "utf8")).toBeLessThan(
      BODY_BYTES_CAP + 200,
    );
  });

  test("reports an error for an unparsable commit date", () => {
    const built = buildCommitMemory(
      commit({ commitDate: "not-a-date" }),
      ctx(),
    );
    expect(built).toEqual({ error: "invalid commit date: not-a-date" });
  });
});

describe("mergeSkipReason", () => {
  test("non-merge commits are never skipped", () => {
    expect(mergeSkipReason(commit({ body: "" }))).toBeNull();
  });

  test("body-less merges are boilerplate", () => {
    expect(mergeSkipReason(commit({ parents: [SHA_B, SHA_C], body: "" }))).toBe(
      "merge_boilerplate",
    );
  });

  test("merges with a body (PR merges) are kept", () => {
    expect(
      mergeSkipReason(
        commit({ parents: [SHA_B, SHA_C], body: "Fix auth refresh (#42)" }),
      ),
    ).toBeNull();
  });
});
