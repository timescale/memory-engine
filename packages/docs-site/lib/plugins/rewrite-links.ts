import path from "node:path";
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Rewrite hrefs inside the rendered docs HTML.
 *
 * - Strips trailing `.md` from internal links so cross-doc references work
 *   under the Next.js routing (`../formats.md` -> `../formats`).
 * - **Resolves relative paths against the source slug's directory** to
 *   produce absolute URLs. This is required because we serve pages with
 *   directory-style URLs (`/getting-started/`), so a literal browser
 *   interpretation of `concepts.md` from `/getting-started/` would be
 *   `/getting-started/concepts/` -- wrong. We resolve filesystem-style
 *   (relative to the source markdown file) and emit absolute URLs.
 * - Adds a trailing slash to internal page links (matches `trailingSlash:
 *   true` in next.config.ts).
 * - Adds `target="_blank" rel="noopener noreferrer"` to external links so
 *   they open in a new tab.
 *
 * Anchors (`#section`), mailto:, and other protocol links are left alone.
 */
export function rehypeRewriteLinks(sourceSlug: string) {
  // Filesystem-style directory of the source slug:
  //   ""               -> ""    (home)
  //   "concepts"       -> ""    (root-level page)
  //   "cli/me-memory"  -> "cli"
  const sourceDir =
    sourceSlug === "" ? "" : sourceSlug.split("/").slice(0, -1).join("/");

  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string" || href.length === 0) return;

      node.properties = node.properties ?? {};

      // External URL -- annotate but don't rewrite.
      if (/^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:")) {
        node.properties.target = "_blank";
        node.properties.rel = "noopener noreferrer";
        return;
      }

      // Pure anchor -- leave alone.
      if (href.startsWith("#")) return;

      // Split off any trailing #anchor.
      const hashIdx = href.indexOf("#");
      const rawPath = hashIdx === -1 ? href : href.slice(0, hashIdx);
      const hash = hashIdx === -1 ? "" : href.slice(hashIdx);

      // Resolve relative paths against source dir to produce an absolute
      // path. Already-absolute paths (leading "/") pass through unchanged.
      let absPath: string;
      if (rawPath.startsWith("/")) {
        absPath = rawPath;
      } else {
        // Empty `sourceDir` is the docs root; pass "." to path.posix.join
        // so the result has no spurious leading "/".
        const joined = path.posix.normalize(
          path.posix.join(sourceDir || ".", rawPath),
        );
        // Strip any leading "./" the normalizer leaves in.
        absPath = `/${joined.replace(/^\.\/?/, "")}`;
      }

      // Strip .md.
      let finalPath = absPath.replace(/\.md$/i, "");

      // Add trailing slash for directory-style page links. Skip when the
      // path already ends in "/" or in a non-".md" file extension (e.g.
      // .png, .svg) -- those are assets, not pages.
      if (
        finalPath.length > 0 &&
        !finalPath.endsWith("/") &&
        !/\.[a-z0-9]{2,5}$/i.test(finalPath)
      ) {
        finalPath = `${finalPath}/`;
      }

      node.properties.href = finalPath + hash;
    });
  };
}
