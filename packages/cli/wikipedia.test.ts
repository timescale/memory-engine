import { describe, expect, test } from "bun:test";
import {
  buildWikipediaArticleUrl,
  buildWikipediaDumpUrl,
  buildWikipediaMemory,
  cleanWikitextToPlainText,
  deterministicWikipediaPageUuidV7,
  extractCategories,
  inferDumpDateFromDumpName,
  inferDumpKindFromDumpName,
  inferWikiSlugFromDumpName,
  parseMediaWikiPageXml,
  streamMediaWikiPages,
} from "./wikipedia.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Wikipedia dump helpers", () => {
  test("builds canonical Wikimedia dump URLs", () => {
    expect(buildWikipediaDumpUrl("simplewiki")).toBe(
      "https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles-multistream.xml.bz2",
    );
    expect(buildWikipediaDumpUrl("enwiki", "20260501", "pages-articles")).toBe(
      "https://dumps.wikimedia.org/enwiki/20260501/enwiki-20260501-pages-articles.xml.bz2",
    );
  });

  test("infers wiki slug and date from dump names", () => {
    const name = "enwiki-20260501-pages-articles-multistream.xml.bz2";
    expect(inferWikiSlugFromDumpName(name)).toBe("enwiki");
    expect(inferDumpDateFromDumpName(name)).toBe("20260501");
    expect(inferDumpKindFromDumpName(name)).toBe("pages-articles-multistream");
  });

  test("parses one MediaWiki page XML block", () => {
    const page = parseMediaWikiPageXml(`
<page>
  <title>PostgreSQL</title>
  <ns>0</ns>
  <id>23456</id>
  <revision>
    <id>98765</id>
    <timestamp>2026-05-01T12:34:56Z</timestamp>
    <model>wikitext</model>
    <format>text/x-wiki</format>
    <text bytes="42">'''PostgreSQL''' is an [[open-source]] database &amp; server.</text>
    <sha1>abc123</sha1>
  </revision>
</page>`);

    expect(page).toEqual({
      title: "PostgreSQL",
      namespace: 0,
      pageId: "23456",
      revisionId: "98765",
      timestamp: "2026-05-01T12:34:56Z",
      text: "'''PostgreSQL''' is an [[open-source]] database & server.",
      redirectTitle: undefined,
      model: "wikitext",
      format: "text/x-wiki",
      sha1: "abc123",
      textBytes: 42,
    });
  });

  test("streams pages across chunk boundaries", async () => {
    const xml = `<mediawiki><page><title>A</title><ns>0</ns><id>1</id><revision><id>11</id><text>Alpha</text></revision></page><page><title>B</title><ns>0</ns><id>2</id><revision><id>22</id><text>Beta</text></revision></page></mediawiki>`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(xml.slice(0, 75)));
        controller.enqueue(encoder.encode(xml.slice(75)));
        controller.close();
      },
    });

    const pages = [];
    for await (const page of streamMediaWikiPages(stream)) {
      pages.push(page.title);
    }

    expect(pages).toEqual(["A", "B"]);
  });

  test("extracts categories", () => {
    expect(
      extractCategories(
        "[[Category:Relational databases]] [[Category:Free software|Databases]] [[category:Relational databases]]",
      ),
    ).toEqual(["Relational databases", "Free software"]);
  });

  test("cleans wikitext into readable text", () => {
    const cleaned = cleanWikitextToPlainText(`{{Infobox}}
[[File:Fan.jpg|thumb|A [[fan]] moves air.]]
'''PostgreSQL''' is an [[open-source software|open-source]] [[database]].<ref>noise</ref>

== History ==
* Created at [https://example.com Berkeley]

== References ==
* [https://example.com]

== Empty section ==
[[Category:Relational databases]]`);

    expect(cleaned).toContain("PostgreSQL is an open-source database.");
    expect(cleaned).toContain("## History");
    expect(cleaned).toContain("- Created at Berkeley");
    expect(cleaned).not.toContain("Infobox");
    expect(cleaned).not.toContain("moves air");
    expect(cleaned).not.toContain("Category");
    expect(cleaned).not.toContain("References");
    expect(cleaned).not.toContain("Empty section");
    expect(cleaned).not.toContain("\n-\n");
    expect(cleaned).not.toContain("noise");
    expect(cleaned).not.toContain("]]");
  });

  test("builds memory payload with stable metadata", () => {
    const page = parseMediaWikiPageXml(`
<page>
  <title>PostgreSQL</title>
  <ns>0</ns>
  <id>23456</id>
  <revision>
    <id>98765</id>
    <timestamp>2026-05-01T12:34:56Z</timestamp>
    <model>wikitext</model>
    <format>text/x-wiki</format>
    <text bytes="120">'''PostgreSQL''' is an [[open-source software|open-source]] database. [[Category:Relational databases]]</text>
    <sha1>abc123</sha1>
  </revision>
</page>`);
    expect(page).not.toBeNull();

    const built = buildWikipediaMemory(page!, {
      wikiSlug: "enwiki",
      treeRoot: "share.wikipedia",
      contentMode: "plain",
      sourceDumpPath: "/tmp/enwiki-latest-pages-articles-multistream.xml.bz2",
      sourceDumpUrl:
        "https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles-multistream.xml.bz2",
      sourceDumpDate: "latest",
      sourceDumpKind: "pages-articles-multistream",
      importedAt: "2026-05-07T00:00:00.000Z",
    });

    expect(built).not.toBeNull();
    expect(built!.memory.id).toMatch(UUIDV7_RE);
    expect(built!.memory.tree).toBe("share.wikipedia.relational_databases");
    expect(built!.memory.content).toContain(
      "# PostgreSQL\n\nPostgreSQL is an open-source database.",
    );
    expect(built!.memory.meta).toMatchObject({
      type: "wikipedia_article",
      source: "wikipedia",
      source_wiki: "enwiki",
      source_page_id: "23456",
      source_revision_id: "98765",
      source_title: "PostgreSQL",
      source_url: "https://en.wikipedia.org/wiki/PostgreSQL",
      source_format: "mediawiki_xml",
      content_format: "plain_text",
      categories: ["Relational databases"],
      primary_category: "Relational databases",
      primary_category_slug: "relational_databases",
      article_slug: "postgresql",
      imported_at: "2026-05-07T00:00:00.000Z",
      importer_version: "1",
    });
    expect(built!.memory.temporal).toEqual({
      start: "2026-05-01T12:34:56.000Z",
    });
  });

  test("deterministic page ids are stable and page-keyed", () => {
    const first = deterministicWikipediaPageUuidV7("enwiki", "23456");
    const second = deterministicWikipediaPageUuidV7("enwiki", "23456");
    const differentWiki = deterministicWikipediaPageUuidV7(
      "simplewiki",
      "23456",
    );

    expect(first).toBe(second);
    expect(first).toMatch(UUIDV7_RE);
    expect(differentWiki).not.toBe(first);
  });

  test("builds article URLs", () => {
    expect(buildWikipediaArticleUrl("enwiki", "A/B test"));
    expect(buildWikipediaArticleUrl("enwiki", "A/B test")).toBe(
      "https://en.wikipedia.org/wiki/A%2FB_test",
    );
  });
});
