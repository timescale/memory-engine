/**
 * Tests for git-backed file discovery, against real scratch repos: ls-files
 * discovery (tracked + untracked, gitignore respected, subdir scoping),
 * the single-pass last-modified walk (dates, renames, subdir relativity,
 * empty repos), and work-tree / shallow detection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isShallowRepository,
  lastModifiedByPath,
  listGitFiles,
} from "./git-files.ts";

const execFileAsync = promisify(execFile);

const DATE_README = "2026-01-01T10:00:00Z";
const DATE_GUIDE = "2026-02-02T10:00:00Z";
const DATE_RENAME = "2026-03-03T10:00:00Z";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout;
}

async function commitAll(cwd: string, message: string, date: string) {
  await git(cwd, "add", "-A");
  await execFileAsync("git", ["-C", cwd, "commit", "-q", "-m", message], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

let root: string;
let repo: string;
let emptyRepo: string;
let plainDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "me-git-files-"));
  repo = join(root, "repo");
  emptyRepo = join(root, "empty");
  plainDir = join(root, "plain");
  await mkdir(repo);
  await mkdir(emptyRepo);
  await mkdir(plainDir);

  await git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "# Readme\n");
  await writeFile(join(repo, ".gitignore"), "dist/\n");
  await commitAll(repo, "readme", DATE_README);

  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "docs", "guide.md"), "# Guide\n");
  await writeFile(join(repo, "docs", "old-name.md"), "# Old\n");
  await commitAll(repo, "docs", DATE_GUIDE);

  await git(repo, "mv", "docs/old-name.md", "docs/new-name.md");
  await commitAll(repo, "rename", DATE_RENAME);

  // Untracked-but-not-ignored + gitignored files, never committed.
  await writeFile(join(repo, "untracked.md"), "# New doc\n");
  await mkdir(join(repo, "dist"));
  await writeFile(join(repo, "dist", "ignored.md"), "# Build output\n");

  await git(emptyRepo, "init", "-q");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listGitFiles", () => {
  test("lists tracked + untracked, respects gitignore", async () => {
    const files = await listGitFiles(repo);
    expect(files).toContain("README.md");
    expect(files).toContain("docs/guide.md");
    expect(files).toContain("docs/new-name.md");
    expect(files).toContain("untracked.md");
    expect(files).not.toContain("docs/old-name.md");
    expect(files).not.toContain("dist/ignored.md");
  });

  test("scopes to a subdir with subdir-relative paths", async () => {
    const files = await listGitFiles(join(repo, "docs"));
    expect(files.sort()).toEqual(["guide.md", "new-name.md"]);
  });
});

describe("lastModifiedByPath", () => {
  test("dates each path at its newest touching commit", async () => {
    const dates = await lastModifiedByPath(
      repo,
      new Set([
        "README.md",
        "docs/guide.md",
        "docs/new-name.md",
        "untracked.md",
      ]),
    );
    expect(Date.parse(dates.get("README.md") ?? "")).toBe(
      Date.parse(DATE_README),
    );
    expect(Date.parse(dates.get("docs/guide.md") ?? "")).toBe(
      Date.parse(DATE_GUIDE),
    );
    // A renamed file is dated at the rename commit (its current path's birth).
    expect(Date.parse(dates.get("docs/new-name.md") ?? "")).toBe(
      Date.parse(DATE_RENAME),
    );
    // Never committed → no date (callers degrade per-file).
    expect(dates.has("untracked.md")).toBe(false);
  });

  test("subdir scoping returns subdir-relative paths", async () => {
    const dates = await lastModifiedByPath(
      join(repo, "docs"),
      new Set(["guide.md", "new-name.md"]),
    );
    expect(Date.parse(dates.get("guide.md") ?? "")).toBe(
      Date.parse(DATE_GUIDE),
    );
    expect(Date.parse(dates.get("new-name.md") ?? "")).toBe(
      Date.parse(DATE_RENAME),
    );
  });

  test("a repo with no commits yields no dates, not an error", async () => {
    const dates = await lastModifiedByPath(emptyRepo, new Set(["a.md"]));
    expect(dates.size).toBe(0);
  });

  test("empty target set short-circuits", async () => {
    const dates = await lastModifiedByPath(repo, new Set());
    expect(dates.size).toBe(0);
  });
});

describe("isShallowRepository", () => {
  test("false for a full clone, true for --depth 1", async () => {
    expect(await isShallowRepository(repo)).toBe(false);
    const shallow = join(root, "shallow");
    await execFileAsync(
      "git",
      ["clone", "-q", "--depth", "1", `file://${repo}`, shallow],
      { encoding: "utf8" },
    );
    expect(await isShallowRepository(shallow)).toBe(true);
  });

  test("false for a plain dir", async () => {
    expect(await isShallowRepository(plainDir)).toBe(false);
  });
});
