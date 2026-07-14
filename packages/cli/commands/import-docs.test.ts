/**
 * Tests for `me import docs` option assembly/validation and the --prune
 * keep-list plumbing. The reconcile semantics live server-side
 * (memory.deleteOrphansInTree — see the space migration and server RPC integration
 * tests); the build and discovery paths are exercised by the importer's own
 * tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { DEFAULT_DOC_PATTERNS } from "../importers/docs.ts";
import { displayTreePath } from "../util.ts";
import {
  buildDocsImportOptions,
  buildKeepList,
  keepListBytes,
  PRUNE_KEEP_BYTES_BUDGET,
  subdirRootError,
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
      gitAware: false,
      includeIgnored: false,
      allowSubdirRoot: false,
      skipIfEmpty: false,
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
      gitAware: true,
      includeIgnored: true,
      dryRun: true,
      verbose: true,
    });
    expect(opts.dir).toBe("../site");
    expect(opts.tree).toBe("~/work");
    expect(opts.include).toEqual(["docs/**"]);
    expect(opts.exclude).toEqual(["docs/internal/**", "**/*.mdx"]);
    expect(opts.temporalKey).toBe("date");
    expect(opts.parseTemporal).toBe(false);
    expect(opts.gitAware).toBe(true);
    expect(opts.includeIgnored).toBe(true);
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

  test("maps --allow-subdir-root through (default off)", () => {
    expect(buildDocsImportOptions(undefined, {}).allowSubdirRoot).toBe(false);
    expect(
      buildDocsImportOptions(undefined, { allowSubdirRoot: true })
        .allowSubdirRoot,
    ).toBe(true);
  });

  test("rejects --include-ignored without --git-aware", () => {
    expect(() =>
      buildDocsImportOptions(undefined, { includeIgnored: true }),
    ).toThrow(/--include-ignored requires --git-aware/);
  });
});

describe("displayTreePath (CLI output form)", () => {
  test("renders input-form trees canonically", () => {
    expect(displayTreePath("~/projects.tiger_data_docs.docs")).toBe(
      "~/projects/tiger_data_docs/docs",
    );
    expect(displayTreePath("share.projects.x.docs")).toBe(
      "/share/projects/x/docs",
    );
    expect(displayTreePath("~/already/slashed")).toBe("~/already/slashed");
    expect(displayTreePath("/share/mixed.form")).toBe("/share/mixed/form");
  });
});

describe("subdirRootError", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "me-subdir-root-"));
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "docs", "guides"));
    await symlink(root, join(root, "self-link"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const DOCS_TREE = "~/projects.acme.docs";

  test("refuses a subfolder root, showing where the same file would land under each root", () => {
    const err = subdirRootError(join(root, "docs"), root, DOCS_TREE, false);
    expect(err).toContain("subfolder of the git repo");
    // The example destinations use the run's real docs root (display form)
    // and the actual relative prefix, slugified as the importer would.
    expect(err).toContain("~/projects/acme/docs/setup.md");
    expect(err).toContain("~/projects/acme/docs/docs/setup.md");
    // Plus the paste-able root-rooted alternative and the opt-in flag.
    expect(err).toContain(`--include 'docs/**'`);
    expect(err).toContain("--allow-subdir-root");
  });

  test("the example and glob reflect nesting depth", () => {
    const err = subdirRootError(
      join(root, "docs", "guides"),
      root,
      DOCS_TREE,
      false,
    );
    expect(err).toContain("~/projects/acme/docs/docs/guides/setup.md");
    expect(err).toContain(`--include 'docs/guides/**'`);
  });

  test("the toplevel itself needs no flag", () => {
    expect(subdirRootError(root, root, DOCS_TREE, false)).toBeUndefined();
  });

  test("--allow-subdir-root suppresses the refusal", () => {
    expect(
      subdirRootError(join(root, "docs"), root, DOCS_TREE, true),
    ).toBeUndefined();
  });

  test("compares realpaths, so a symlinked spelling of the toplevel passes", () => {
    // git prints physical paths (macOS /tmp → /private/tmp); an argument
    // that reaches the same directory through a symlink is not a subfolder.
    expect(
      subdirRootError(join(root, "self-link"), root, DOCS_TREE, false),
    ).toBeUndefined();
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

  test("buildKeepList fails fast on a nameless payload (invariant)", () => {
    // A nameless slot would silently shrink the keep-set (over-delete risk);
    // the invariant violation must surface as a pointed error instead.
    expect(() =>
      buildKeepList([{ payload: { content: "x", tree: "~/p.docs" } }]),
    ).toThrow(/missing a name/);
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
