/**
 * Tests for `me import slab`: option assembly/validation and the directory
 * walk (sorted order, empty-file skipping). No engine RPC — the write path is
 * exercised by the importer's pure builders (importers/slab.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkSlabDir } from "../importers/slab.ts";
import { buildSlabImportOptions } from "./import-slab.ts";

describe("buildSlabImportOptions", () => {
  test("applies defaults", () => {
    const opts = buildSlabImportOptions("/data", {});
    expect(opts).toEqual({
      dir: "/data",
      treeRoot: "share.slab",
      uncategorizedNode: "uncategorized",
      parseTemporal: true,
      dryRun: false,
      verbose: false,
    });
  });

  test("maps flags through", () => {
    const opts = buildSlabImportOptions("/data", {
      treeRoot: "~/kb",
      uncategorizedNode: "misc",
      temporal: false, // --no-temporal
      dryRun: true,
      verbose: true,
    });
    expect(opts.treeRoot).toBe("~/kb");
    expect(opts.uncategorizedNode).toBe("misc");
    expect(opts.parseTemporal).toBe(false);
    expect(opts.dryRun).toBe(true);
    expect(opts.verbose).toBe(true);
  });

  test("rejects an invalid --tree-root", () => {
    expect(() =>
      buildSlabImportOptions("/data", { treeRoot: "bad path!" }),
    ).toThrow(/Invalid --tree-root/);
  });

  test("rejects an invalid --uncategorized-node", () => {
    expect(() =>
      buildSlabImportOptions("/data", { uncategorizedNode: "Bad-Node" }),
    ).toThrow(/Invalid --uncategorized-node/);
  });
});

describe("walkSlabDir", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "slab-walk-"));
    mkdirSync(join(dir, "Topic"), { recursive: true });
    await writeFile(join(dir, "b-root.md"), "# B\n\nbody");
    await writeFile(join(dir, "a-root.md"), "# A\n\nbody");
    await writeFile(join(dir, "empty.md"), "   \n  \n"); // whitespace-only -> skipped
    await writeFile(join(dir, "Topic", "nested.md"), "# Nested\n\nbody");
    await writeFile(join(dir, "Topic", "notes.txt"), "ignored"); // non-md -> skipped
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("yields non-empty .md files in sorted order, skipping empties and non-md", async () => {
    const seen: string[] = [];
    for await (const f of walkSlabDir(dir)) {
      seen.push(f.relPath);
    }
    expect(seen).toEqual(["Topic/nested.md", "a-root.md", "b-root.md"]);
  });

  test("trims content", async () => {
    const byPath = new Map<string, string>();
    for await (const f of walkSlabDir(dir)) {
      byPath.set(f.relPath, f.content);
    }
    expect(byPath.get("a-root.md")).toBe("# A\n\nbody");
  });
});
