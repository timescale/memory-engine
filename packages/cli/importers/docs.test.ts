/**
 * Tests for the docs importer's pure builders: lenient frontmatter →
 * meta.doc, mdx statement stripping, tree/name derivation, temporal/id
 * coupling, cap behavior, and the mode-agnostic include/exclude filter.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDocMemory,
  DEFAULT_DOC_PATTERNS,
  DOC_BODY_BYTES_CAP,
  DOCS_IMPORTER_VERSION,
  type DocsMemoryContext,
  deriveDocTemporal,
  filterDocPaths,
  parseDocFrontmatter,
  stripMdxStatements,
} from "./docs.ts";

function ctx(overrides: Partial<DocsMemoryContext> = {}): DocsMemoryContext {
  return {
    docsTree: "share.projects.acme.docs",
    parseTemporal: true,
    usedNames: new Map(),
    ...overrides,
  };
}

describe("parseDocFrontmatter", () => {
  test("parses a clean YAML object and strips it from the body", () => {
    const res = parseDocFrontmatter(
      "---\ntitle: Setup Guide\ntags: [a, b]\n---\n# Body\n",
    );
    expect(res.doc).toEqual({ title: "Setup Guide", tags: ["a", "b"] });
    expect(res.body).toBe("# Body\n");
  });

  test("invalid YAML keeps the whole input verbatim, no doc", () => {
    const input = "---\ntitle: [unclosed\n---\nbody\n";
    const res = parseDocFrontmatter(input);
    expect(res.doc).toBeUndefined();
    expect(res.body).toBe(input);
  });

  test("non-object YAML (scalar / array) keeps the input verbatim", () => {
    for (const input of [
      "---\n42\n---\nbody\n",
      "---\n- a\n- b\n---\nbody\n",
    ]) {
      const res = parseDocFrontmatter(input);
      expect(res.doc).toBeUndefined();
      expect(res.body).toBe(input);
    }
  });

  test("no frontmatter block passes through untouched", () => {
    const res = parseDocFrontmatter("# Just markdown\n");
    expect(res.doc).toBeUndefined();
    expect(res.body).toBe("# Just markdown\n");
  });
});

describe("stripMdxStatements", () => {
  test("drops top-level import/export lines, keeps prose and JSX", () => {
    const body = [
      "import Tabs from '@theme/Tabs';",
      "export const x = 1;",
      "",
      "# Title",
      "<Tabs>hello</Tabs>",
      "important prose about exports",
    ].join("\n");
    expect(stripMdxStatements(body)).toBe(
      [
        "",
        "# Title",
        "<Tabs>hello</Tabs>",
        "important prose about exports",
      ].join("\n"),
    );
  });

  test("keeps import lines inside fenced code blocks", () => {
    const body = [
      "import Real from 'x';",
      "```ts",
      "import Example from 'y';",
      "```",
      "done",
    ].join("\n");
    expect(stripMdxStatements(body)).toBe(
      ["```ts", "import Example from 'y';", "```", "done"].join("\n"),
    );
  });

  test("a multi-line import only loses its first line (accepted edge)", () => {
    const body = ["import {", "  a,", "} from 'x';", "text"].join("\n");
    expect(stripMdxStatements(body)).toBe(
      ["  a,", "} from 'x';", "text"].join("\n"),
    );
  });
});

describe("buildDocMemory", () => {
  test("derives tree from the relative dir and name from the filename", () => {
    const m = buildDocMemory(
      "guides/Getting Started.md",
      "# Hi\n",
      undefined,
      ctx(),
    );
    expect(m?.tree).toBe("share.projects.acme.docs.guides");
    expect(m?.name).toBe("getting-started.md");
    expect(m?.meta?.repo_path).toBe("guides/Getting Started.md");
    expect(m?.meta?.source).toBe("docs");
    expect(m?.meta?.importer_version).toBe(DOCS_IMPORTER_VERSION);
  });

  test("root-level files sit directly at the docs root", () => {
    const m = buildDocMemory("README.md", "# Readme\n", undefined, ctx());
    expect(m?.tree).toBe("share.projects.acme.docs");
    expect(m?.name).toBe("readme.md");
  });

  test("collision suffix lands before the extension", () => {
    const c = ctx();
    const a = buildDocMemory("a/setup.md", "one\n", undefined, c);
    const b = buildDocMemory("a/Setup!.md", "two\n", undefined, c);
    expect(a?.name).toBe("setup.md");
    expect(b?.name).toBe("setup-2.md");
  });

  test("frontmatter lands in meta.doc, never as engine fields", () => {
    const raw = [
      "---",
      "id: not-a-uuid",
      "title: My Doc",
      "tree: evil.override",
      "sidebar_position: 3",
      "---",
      "body text",
    ].join("\n");
    const m = buildDocMemory("a.md", raw, undefined, ctx());
    expect(m?.tree).toBe("share.projects.acme.docs");
    expect(m?.name).toBe("a.md");
    expect(m?.id).toBeUndefined();
    expect(m?.content).toBe("body text");
    expect(m?.meta?.doc).toEqual({
      id: "not-a-uuid",
      title: "My Doc",
      tree: "evil.override",
      sidebar_position: 3,
    });
  });

  test("frontmatter title wins over first H1; H1 is the fallback", () => {
    const withFm = buildDocMemory(
      "a.md",
      "---\ntitle: FM Title\n---\n# H1 Title\n",
      undefined,
      ctx(),
    );
    expect(withFm?.meta?.title).toBe("FM Title");
    const noFm = buildDocMemory("b.md", "# H1 Title\nbody", undefined, ctx());
    expect(noFm?.meta?.title).toBe("H1 Title");
    const neither = buildDocMemory(
      "Notes File.md",
      "just text",
      undefined,
      ctx(),
    );
    expect(neither?.meta?.title).toBe("Notes File");
  });

  test("mdx strips top-level statements; md does not", () => {
    const raw = "import X from 'y';\n\n# Doc\n";
    const mdx = buildDocMemory("a.mdx", raw, undefined, ctx());
    expect(mdx?.content).toBe("# Doc");
    expect(mdx?.name).toBe("a.mdx");
    const md = buildDocMemory("b.md", raw, undefined, ctx());
    expect(md?.content).toBe("import X from 'y';\n\n# Doc");
  });

  test("empty after stripping returns null (nothing to embed)", () => {
    expect(buildDocMemory("e.md", "   \n", undefined, ctx())).toBeNull();
    expect(
      buildDocMemory("e.mdx", "import X from 'y';\n", undefined, ctx()),
    ).toBeNull();
    expect(
      buildDocMemory("f.md", "---\ntitle: only fm\n---\n\n", undefined, ctx()),
    ).toBeNull();
  });

  test("git last-modified becomes the temporal and seeds the id", () => {
    const iso = "2026-03-04T05:06:07Z";
    const m = buildDocMemory("a.md", "body\n", iso, ctx());
    expect(m?.temporal).toEqual({ start: "2026-03-04T05:06:07.000Z" });
    expect(m?.id).toBeDefined();
    // The uuidv7 timestamp prefix encodes the same date.
    const tsHex = (m?.id as string).replaceAll("-", "").slice(0, 12);
    expect(Number.parseInt(tsHex, 16)).toBe(Date.parse(iso));
  });

  test("no date, no temporal, no id", () => {
    const m = buildDocMemory("a.md", "body\n", undefined, ctx());
    expect(m?.temporal).toBeUndefined();
    expect(m?.id).toBeUndefined();
  });

  test("--no-temporal drops both temporal and id even with a date", () => {
    const m = buildDocMemory(
      "a.md",
      "---\ndate: 2026-01-01\n---\nbody",
      "2026-03-04T05:06:07Z",
      ctx({ parseTemporal: false, temporalKey: "date" }),
    );
    expect(m?.temporal).toBeUndefined();
    expect(m?.id).toBeUndefined();
  });

  test("oversized content is capped with a marker and flagged in meta", () => {
    const big = `# T\n${"x".repeat(DOC_BODY_BYTES_CAP + 1000)}`;
    const m = buildDocMemory("big.md", big, undefined, ctx());
    expect(m?.content.endsWith("…[truncated]")).toBe(true);
    expect(Buffer.byteLength(m?.content ?? "", "utf8")).toBeLessThanOrEqual(
      DOC_BODY_BYTES_CAP + "\n…[truncated]".length * 3,
    );
    expect(m?.meta?.truncated).toBe(true);
    // Deterministic: a second build produces the identical content.
    const again = buildDocMemory("big.md", big, undefined, ctx());
    expect(again?.content).toBe(m?.content);
  });
});

describe("deriveDocTemporal", () => {
  const base = ctx({ temporalKey: "date" });

  test("temporal-key value wins over last-modified", () => {
    expect(
      deriveDocTemporal({ date: "2025-05-05" }, "2026-01-01T00:00:00Z", base),
    ).toEqual({ start: new Date("2025-05-05").toISOString() });
  });

  test("unparseable or missing key falls back to last-modified", () => {
    expect(
      deriveDocTemporal({ date: "not a date" }, "2026-01-01T00:00:00Z", base),
    ).toEqual({ start: "2026-01-01T00:00:00.000Z" });
    expect(deriveDocTemporal({}, "2026-01-01T00:00:00Z", base)).toEqual({
      start: "2026-01-01T00:00:00.000Z",
    });
  });

  test("a YAML Date object value is honored", () => {
    const d = new Date("2025-05-05T00:00:00Z");
    expect(deriveDocTemporal({ date: d }, undefined, base)).toEqual({
      start: "2025-05-05T00:00:00.000Z",
    });
  });

  test("nothing available yields undefined", () => {
    expect(deriveDocTemporal(undefined, undefined, base)).toBeUndefined();
  });
});

describe("filterDocPaths", () => {
  test("defaults include md/markdown/mdx at any depth, nothing else", () => {
    const filtered = filterDocPaths([
      "README.md",
      "docs/a.markdown",
      "docs/deep/b.mdx",
      "src/c.ts",
      "notes.txt",
    ]);
    expect(filtered).toEqual([
      "README.md",
      "docs/a.markdown",
      "docs/deep/b.mdx",
    ]);
  });

  test("include replaces the default set; exclude subtracts", () => {
    const paths = ["README.md", "docs/a.md", "docs/b.mdx", "docs/skip/c.md"];
    expect(
      filterDocPaths(paths, ["docs/**"], ["docs/skip/**", "**/*.mdx"]),
    ).toEqual(["docs/a.md"]);
  });

  test("output is sorted for deterministic slot assignment", () => {
    expect(filterDocPaths(["z.md", "a.md", "m/b.md"])).toEqual([
      "a.md",
      "m/b.md",
      "z.md",
    ]);
  });

  test("DEFAULT_DOC_PATTERNS covers exactly the three extensions", () => {
    expect(DEFAULT_DOC_PATTERNS).toEqual([
      "**/*.md",
      "**/*.markdown",
      "**/*.mdx",
    ]);
  });
});
