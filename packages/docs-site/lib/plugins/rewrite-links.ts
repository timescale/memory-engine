import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Rewrite hrefs inside the rendered docs HTML.
 *
 * - Strips trailing `.md` from internal links so cross-doc references work
 *   under the Next.js routing (`../formats.md` -> `../formats`).
 * - Adds a trailing slash to internal links (matches `trailingSlash: true`
 *   in next.config.ts).
 * - Adds `target="_blank" rel="noopener noreferrer"` to external links so
 *   they open in a new tab.
 *
 * Anchors (`#section`), mailto:, and other protocol links are left alone.
 */
export function rehypeRewriteLinks() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string" || href.length === 0) return;

      // External URL -- annotate but don't rewrite.
      if (/^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:")) {
        node.properties = node.properties ?? {};
        node.properties.target = "_blank";
        node.properties.rel = "noopener noreferrer";
        return;
      }

      // Pure anchor -- leave alone.
      if (href.startsWith("#")) return;

      // Internal link. Split off any trailing #anchor.
      const hashIdx = href.indexOf("#");
      const path = hashIdx === -1 ? href : href.slice(0, hashIdx);
      const hash = hashIdx === -1 ? "" : href.slice(hashIdx);

      // Strip .md extension if present.
      const stripped = path.replace(/\.md$/i, "");

      // Add trailing slash for internal directory-style routes (matches
      // Next.js trailingSlash). Skip if it ends in a file with extension
      // (e.g. .png, .svg) or already has a trailing slash.
      let finalPath = stripped;
      if (
        finalPath.length > 0 &&
        !finalPath.endsWith("/") &&
        !/\.[a-z0-9]{2,5}$/i.test(finalPath)
      ) {
        finalPath = `${finalPath}/`;
      }

      node.properties = node.properties ?? {};
      node.properties.href = finalPath + hash;
    });
  };
}
