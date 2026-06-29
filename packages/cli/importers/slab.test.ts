/**
 * Tests for the Slab importer's pure builders: tree-label and leaf-name
 * normalization, within-tree name dedup, title extraction, filename-date
 * parsing, directory-to-tree mapping, and the per-post memory payload. All
 * pure — no filesystem or RPC. `walkSlabDir` (the one I/O function) is covered
 * in commands/import-slab.test.ts against a temp fixture dir.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSlabMemory,
  extractTitle,
  makeUniqueName,
  normalizeName,
  normalizeTreeLabel,
  parseTemporalFromFilename,
  SLAB_IMPORTER_VERSION,
  type SlabMemoryContext,
  treeForDir,
} from "./slab.ts";

function ctx(overrides: Partial<SlabMemoryContext> = {}): SlabMemoryContext {
  return {
    treeRoot: "share.slab",
    uncategorizedNode: "uncategorized",
    parseTemporal: true,
    usedNames: new Map(),
    ...overrides,
  };
}

describe("normalizeTreeLabel", () => {
  test("slugifies spaces, ampersands, and case", () => {
    expect(normalizeTreeLabel("Customer Success")).toBe("customer_success");
    expect(normalizeTreeLabel("SOPs & Playbooks")).toBe("sops_playbooks");
  });

  test("strips emoji and parentheses", () => {
    expect(normalizeTreeLabel("Tiger Handbook 🐯")).toBe("tiger_handbook");
    expect(normalizeTreeLabel("Marketing(Archive)")).toBe("marketing_archive");
  });

  test("prefixes a purely-numeric label", () => {
    expect(normalizeTreeLabel("2022")).toBe("p_2022");
  });
});

describe("normalizeName", () => {
  // normalizeName returns the extension-less base; `.md` is re-attached in
  // buildSlabMemory after collision resolution.
  test("lowercases and dashes illegal runs", () => {
    expect(normalizeName("How do I book time off.md")).toBe(
      "how-do-i-book-time-off",
    );
  });

  test("keeps dots, drops the .md extension", () => {
    expect(normalizeName("1. G-Suite.md")).toBe("1.-g-suite");
  });

  test("strips leading non-alphanumerics (brackets, emoji)", () => {
    expect(normalizeName("[INITIATIVE] IO optimizations.md")).toBe(
      "initiative-io-optimizations",
    );
    expect(normalizeName("🌙 Moonshot 🌙.md")).toBe("moonshot");
  });

  test("falls back to 'untitled' when nothing survives", () => {
    expect(normalizeName("🌙.md")).toBe("untitled");
  });

  test("truncates the base leaving room for the extension (<= 125)", () => {
    const long = `${"a".repeat(130)}.md`;
    const out = normalizeName(long);
    expect(out.length).toBe(125);
    expect(out.endsWith("-")).toBe(false);
  });
});

describe("makeUniqueName", () => {
  test("returns the name unchanged when free", () => {
    const used = new Map<string, Set<string>>();
    expect(makeUniqueName("share.slab.a", "foo", used)).toBe("foo");
  });

  test("suffixes collisions within the same tree", () => {
    const used = new Map<string, Set<string>>();
    expect(makeUniqueName("share.slab.a", "foo", used)).toBe("foo");
    expect(makeUniqueName("share.slab.a", "foo", used)).toBe("foo-2");
    expect(makeUniqueName("share.slab.a", "foo", used)).toBe("foo-3");
  });

  test("the same name in a different tree does not collide", () => {
    const used = new Map<string, Set<string>>();
    expect(makeUniqueName("share.slab.a", "foo", used)).toBe("foo");
    expect(makeUniqueName("share.slab.b", "foo", used)).toBe("foo");
  });
});

describe("extractTitle", () => {
  test("prefers the first H1", () => {
    expect(extractTitle("# Hello World\n\nbody", "file.md")).toBe(
      "Hello World",
    );
  });

  test("falls back to the filename (sans .md, emoji intact)", () => {
    expect(extractTitle("no heading here", "🐯 Tiger Triumph!.md")).toBe(
      "🐯 Tiger Triumph!",
    );
  });

  test("ignores a non-leading-line H1 only if no earlier H1 exists", () => {
    // First H1 anywhere wins.
    expect(extractTitle("intro\n\n# Real Title\nmore", "f.md")).toBe(
      "Real Title",
    );
  });
});

describe("parseTemporalFromFilename", () => {
  test("parses YYYY-MM-DD", () => {
    expect(parseTemporalFromFilename("2023-01-31.md")).toEqual({
      start: "2023-01-31T00:00:00Z",
    });
  });

  test("parses YYYY.MM.DD", () => {
    expect(parseTemporalFromFilename("2022.09.22.md")).toEqual({
      start: "2022-09-22T00:00:00Z",
    });
  });

  test("parses YYYYMMDD", () => {
    expect(parseTemporalFromFilename("20230504 - PMM Update.md")).toEqual({
      start: "2023-05-04T00:00:00Z",
    });
  });

  test("parses a date prefix followed by a title", () => {
    expect(parseTemporalFromFilename("2023-07-27 (bi-weekly).md")).toEqual({
      start: "2023-07-27T00:00:00Z",
    });
  });

  test("rejects an impossible calendar date", () => {
    expect(parseTemporalFromFilename("2023-02-30.md")).toBeUndefined();
  });

  test("rejects a non-dated filename", () => {
    expect(parseTemporalFromFilename("Sales Training.md")).toBeUndefined();
  });

  test("rejects an out-of-range year", () => {
    expect(parseTemporalFromFilename("1800-01-01.md")).toBeUndefined();
  });
});

describe("treeForDir", () => {
  test("root-level posts go to the uncategorized bucket", () => {
    expect(treeForDir("", ctx())).toBe("share.slab.uncategorized");
    expect(treeForDir(".", ctx())).toBe("share.slab.uncategorized");
  });

  test("maps a nested topic path to slugified ltree labels", () => {
    expect(treeForDir("Customer Success/SOPs & Playbooks", ctx())).toBe(
      "share.slab.customer_success.sops_playbooks",
    );
  });

  test("honors a custom tree root and uncategorized node", () => {
    const c = ctx({ treeRoot: "share.kb", uncategorizedNode: "misc" });
    expect(treeForDir("", c)).toBe("share.kb.misc");
    expect(treeForDir("Engineering", c)).toBe("share.kb.engineering");
  });
});

describe("buildSlabMemory", () => {
  test("builds a full payload with H1 title and topic-derived tree", () => {
    const mem = buildSlabMemory(
      "Customer Success/SOPs & Playbooks/Cloud FAQ.md",
      "# Cloud FAQ\n\nbody text",
      ctx(),
    );
    expect(mem.tree).toBe("share.slab.customer_success.sops_playbooks");
    expect(mem.name).toBe("cloud-faq.md");
    expect(mem.content).toBe("# Cloud FAQ\n\nbody text");
    expect(mem.meta).toEqual({
      title: "Cloud FAQ",
      source: "slab",
      slab_topic_path: "Customer Success/SOPs & Playbooks",
      original_filename: "Cloud FAQ.md",
      importer_version: SLAB_IMPORTER_VERSION,
    });
    expect(mem.temporal).toBeUndefined();
    expect(mem.id).toBeUndefined();
  });

  test("a dated post gets a temporal and a date-seeded v7 id", () => {
    const mem = buildSlabMemory("2023-05-04.md", "weekly update", ctx());
    expect(mem.tree).toBe("share.slab.uncategorized");
    expect(mem.temporal).toEqual({ start: "2023-05-04T00:00:00Z" });
    expect(typeof mem.id).toBe("string");
    // v7 + the date encoded in the 48-bit prefix (2023-05-04 = 0x0187...).
    expect(mem.id?.[14]).toBe("7");
    const prefixMs = Number.parseInt(
      (mem.id as string).replace(/-/g, "").slice(0, 12),
      16,
    );
    expect(prefixMs).toBe(Date.parse("2023-05-04T00:00:00Z"));
  });

  test("--no-temporal disables date parsing and the seeded id", () => {
    const mem = buildSlabMemory(
      "2023-05-04.md",
      "weekly update",
      ctx({ parseTemporal: false }),
    );
    expect(mem.temporal).toBeUndefined();
    expect(mem.id).toBeUndefined();
  });

  test("falls back to filename title when there is no H1", () => {
    const mem = buildSlabMemory(
      "Engineering/Team Structure.md",
      "no heading",
      ctx(),
    );
    expect((mem.meta as Record<string, unknown>).title).toBe("Team Structure");
  });

  test("a very long filename yields a name within the 128-char cap, ending .md", () => {
    const mem = buildSlabMemory(`${"x".repeat(200)}.md`, "body", ctx());
    expect(mem.name?.endsWith(".md")).toBe(true);
    expect((mem.name as string).length).toBeLessThanOrEqual(128);
  });

  test("collisions within a run get unique names via the shared registry", () => {
    const c = ctx();
    const a = buildSlabMemory("T/Plan.md", "a", c);
    const b = buildSlabMemory("T/plan.md", "b", c);
    expect(a.name).toBe("plan.md");
    expect(b.name).toBe("plan-2.md");
    expect(a.tree).toBe(b.tree);
  });
});
