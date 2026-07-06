/**
 * Tests for `me import docs` option assembly/validation. The build and
 * discovery paths are exercised by the importer's own tests
 * (importers/docs.test.ts, importers/git-files.test.ts); no engine RPC here.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_DOC_PATTERNS } from "../importers/docs.ts";
import { buildDocsImportOptions } from "./import-docs.ts";

describe("buildDocsImportOptions", () => {
  test("applies defaults", () => {
    const opts = buildDocsImportOptions(undefined, {});
    expect(opts).toEqual({
      dir: ".",
      tree: undefined,
      include: [...DEFAULT_DOC_PATTERNS],
      exclude: [],
      temporalKey: undefined,
      parseTemporal: true,
      dryRun: false,
      verbose: false,
    });
  });

  test("maps flags through", () => {
    const opts = buildDocsImportOptions("../site", {
      tree: "~/work",
      include: ["docs/**"],
      exclude: ["docs/internal/**", "**/*.mdx"],
      temporalKey: "date",
      temporal: false, // --no-temporal
      dryRun: true,
      verbose: true,
    });
    expect(opts.dir).toBe("../site");
    expect(opts.tree).toBe("~/work");
    expect(opts.include).toEqual(["docs/**"]);
    expect(opts.exclude).toEqual(["docs/internal/**", "**/*.mdx"]);
    expect(opts.temporalKey).toBe("date");
    expect(opts.parseTemporal).toBe(false);
    expect(opts.dryRun).toBe(true);
    expect(opts.verbose).toBe(true);
  });

  test("an empty --include list falls back to the defaults", () => {
    const opts = buildDocsImportOptions(undefined, { include: [] });
    expect(opts.include).toEqual([...DEFAULT_DOC_PATTERNS]);
  });

  test("rejects an invalid --tree", () => {
    expect(() =>
      buildDocsImportOptions(undefined, { tree: "bad path!" }),
    ).toThrow(/Invalid --tree/);
  });

  test("accepts ~ and / tree spellings", () => {
    expect(
      buildDocsImportOptions(undefined, { tree: "~/projects/x" }).tree,
    ).toBe("~/projects/x");
    expect(
      buildDocsImportOptions(undefined, { tree: "share.projects.x" }).tree,
    ).toBe("share.projects.x");
  });
});
