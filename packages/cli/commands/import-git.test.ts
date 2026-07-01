/**
 * Tests for `me import git` option assembly.
 */
import { describe, expect, test } from "bun:test";
import { buildGitImportOptions } from "./import-git.ts";

describe("buildGitImportOptions", () => {
  test("applies defaults", () => {
    const opts = buildGitImportOptions({});
    expect(opts).toEqual({
      repo: undefined,
      branch: undefined,
      since: undefined,
      until: undefined,
      maxCount: undefined,
      full: false,
      merges: true,
      fileList: true,
      projectTree: undefined,
      dryRun: false,
      verbose: false,
      skipIfNotRepo: false,
    });
  });

  test("maps flags through", () => {
    const opts = buildGitImportOptions(
      {
        branch: "main",
        since: "2 weeks ago",
        until: "2026-01-01",
        maxCount: 100,
        full: true,
        merges: false,
        fileList: false,
        projectTree: "~/work",
        dryRun: true,
        verbose: true,
        skipIfNotRepo: true,
      },
      "/some/repo",
    );
    expect(opts.repo).toBe("/some/repo");
    expect(opts.branch).toBe("main");
    expect(opts.since).toBe("2 weeks ago");
    expect(opts.until).toBe("2026-01-01");
    expect(opts.maxCount).toBe(100);
    expect(opts.full).toBe(true);
    expect(opts.merges).toBe(false);
    expect(opts.fileList).toBe(false);
    expect(opts.projectTree).toBe("~/work");
    expect(opts.dryRun).toBe(true);
    expect(opts.verbose).toBe(true);
    expect(opts.skipIfNotRepo).toBe(true);
  });

  test("rejects an invalid --project-tree", () => {
    expect(() => buildGitImportOptions({ projectTree: "bad path!" })).toThrow(
      /Invalid --project-tree/,
    );
  });
});
