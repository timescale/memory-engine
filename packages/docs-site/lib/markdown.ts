import type { Element, Root } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createHighlighter, type Highlighter } from "shiki";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { remarkAdmonitions } from "./plugins/admonitions";
import { rehypeRewriteLinks } from "./plugins/rewrite-links";

export type TocEntry = {
  level: 2 | 3;
  text: string;
  id: string;
};

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark-default"],
      langs: [
        "bash",
        "shell",
        "json",
        "typescript",
        "javascript",
        "tsx",
        "jsx",
        "python",
        "sql",
        "yaml",
        "toml",
        "markdown",
        "diff",
        "text",
        "ini",
        "dockerfile",
      ],
    });
  }
  return highlighterPromise;
}

/**
 * Replace each `<pre><code class="language-*">…</code></pre>` block in the
 * tree with the Shiki-highlighted equivalent.
 */
function rehypeShikiHighlight(highlighter: Highlighter) {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (
        node.tagName !== "pre" ||
        !parent ||
        typeof index !== "number" ||
        node.children.length !== 1
      ) {
        return;
      }
      const child = node.children[0];
      if (
        !child ||
        child.type !== "element" ||
        child.tagName !== "code" ||
        !child.properties
      ) {
        return;
      }
      const classes =
        (child.properties.className as string[] | undefined) ?? [];
      const langClass = classes.find((c) => c.startsWith("language-"));
      const lang = langClass ? langClass.replace("language-", "") : "text";
      const code = hastToString(child).replace(/\n$/, "");

      let highlighted: string;
      try {
        highlighted = highlighter.codeToHtml(code, {
          lang: highlighter.getLoadedLanguages().includes(lang as never)
            ? lang
            : "text",
          theme: "github-dark-default",
        });
      } catch {
        highlighted = highlighter.codeToHtml(code, {
          lang: "text",
          theme: "github-dark-default",
        });
      }

      // The `highlighted` value is full HTML (a `<pre>` element). Replace the
      // current pre node with a raw HTML node.
      // biome-ignore lint/suspicious/noExplicitAny: hast raw nodes are produced via remark-rehype passthrough
      (parent.children[index] as any) = {
        type: "raw",
        value: highlighted,
      };
    });
  };
}

/**
 * Capture the page TOC (h2 + h3) by walking the hast tree.
 */
function rehypeCollectToc(out: TocEntry[]) {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "h2" && node.tagName !== "h3") return;
      const id = node.properties?.id;
      if (typeof id !== "string") return;
      // Skip the auto-generated permalink anchor child when reading text.
      const text = hastToString({
        type: "root",
        children: node.children.filter(
          (c) =>
            !(
              c.type === "element" &&
              (c.properties?.className as string[] | undefined)?.includes(
                "heading-anchor",
              )
            ),
        ),
      } as Root);
      out.push({
        level: node.tagName === "h2" ? 2 : 3,
        text: text.trim(),
        id,
      });
    });
  };
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Capture every heading id and every <a href> on the page. Used by the
 * link-checker to validate cross-document anchors at build time.
 *
 * Runs AFTER `rehypeRewriteLinks` so the captured hrefs match what ends
 * up in the rendered HTML.
 */
function rehypeCollectLinksAndHeadings(
  headingIds: string[],
  linkHrefs: string[],
) {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (HEADING_TAGS.has(node.tagName)) {
        const id = node.properties?.id;
        if (typeof id === "string") headingIds.push(id);
        return;
      }
      if (node.tagName === "a") {
        const href = node.properties?.href;
        if (typeof href === "string") linkHrefs.push(href);
      }
    });
  };
}

export type RenderResult = {
  html: string;
  toc: TocEntry[];
  /** Every heading id on the page, in document order. */
  headingIds: string[];
  /** Every outbound `<a href>` value (post link rewriting). */
  linkHrefs: string[];
};

/**
 * Render Markdown source to an HTML string + TOC + link/heading metadata.
 *
 * `sourceSlug` is the slug of the page being rendered (e.g. `""`,
 * `"concepts"`, `"cli/me-memory"`). It's used by the link rewriter to
 * resolve filesystem-relative `.md` links into absolute URLs.
 */
export async function renderMarkdown(
  source: string,
  sourceSlug: string,
): Promise<RenderResult> {
  const highlighter = await getHighlighter();
  const toc: TocEntry[] = [];
  const headingIds: string[] = [];
  const linkHrefs: string[] = [];

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkAdmonitions)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: "prepend",
      properties: {
        className: ["heading-anchor"],
        ariaLabel: "Link to this section",
      },
      content: { type: "text", value: "#" },
    })
    .use(rehypeShikiHighlight, highlighter)
    .use(rehypeRewriteLinks, sourceSlug)
    .use(rehypeCollectToc, toc)
    .use(rehypeCollectLinksAndHeadings, headingIds, linkHrefs)
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(source);

  return { html: String(file), toc, headingIds, linkHrefs };
}
