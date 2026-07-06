/**
 * Tests for `me import docs` option assembly/validation and the --prune
 * keep-list plumbing. The reconcile semantics live server-side
 * (memory.reconcileTree — see the space migration and server RPC integration
 * tests); the build and discovery paths are exercised by the importer's own
 * tests.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { DEFAULT_DOC_PATTERNS } from "../importers/docs.ts";
import {
  buildDocsImportOptions,
  buildKeepList,
  keepListBytes,
  PRUNE_KEEP_BYTES_BUDGET,
} from "./import-docs.ts";

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
      prune: false,
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

  test("maps --prune through (default off)", () => {
    expect(buildDocsImportOptions(undefined, {}).prune).toBe(false);
    expect(buildDocsImportOptions(undefined, { prune: true }).prune).toBe(true);
  });
});

describe("prune keep-list plumbing", () => {
  const payload = (
    tree: string,
    name: string,
  ): { payload: MemoryCreateParams } => ({
    payload: { content: "x", tree, name },
  });

  test("buildKeepList maps planned payloads to (tree, name) slots", () => {
    const keep = buildKeepList([
      payload("~/p.docs", "a.md"),
      payload("~/p.docs.guides", "b.md"),
    ]);
    expect(keep).toEqual([
      { tree: "~/p.docs", name: "a.md" },
      { tree: "~/p.docs.guides", name: "b.md" },
    ]);
  });

  test("keepListBytes tracks serialized size against the budget", () => {
    const small = buildKeepList([payload("~/p.docs", "a.md")]);
    expect(keepListBytes(small)).toBeLessThan(PRUNE_KEEP_BYTES_BUDGET);

    // ~30k slots of ~60 bytes each overflows the 768 KiB budget — the run
    // must refuse rather than chunk (a NOT-IN keep-list cannot be split).
    const big = buildKeepList(
      Array.from({ length: 30_000 }, (_, i) =>
        payload(
          "~/p.docs.some.nested.dir",
          `doc-${String(i).padStart(6, "0")}.md`,
        ),
      ),
    );
    expect(keepListBytes(big)).toBeGreaterThan(PRUNE_KEEP_BYTES_BUDGET);
  });
});
