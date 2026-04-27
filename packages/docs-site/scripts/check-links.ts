/**
 * Build-time broken-link checker.
 *
 * Renders every Markdown page through the same pipeline as the Next.js
 * build, collects each page's outbound `<a href>` values and heading ids,
 * then validates every internal link.
 *
 * Validates:
 *   - "/foo/"           -> page slug "foo" exists
 *   - "/foo/#bar"       -> page slug "foo" exists AND has heading id "bar"
 *   - "#bar"            -> the current page has heading id "bar"
 *   - "../foo/#bar"     -> resolves relative to current slug, then validates
 *
 * Skips:
 *   - external URLs (http://, https://, mailto:)
 *   - pure fragment links to ids on other elements (e.g. anchors that
 *     point to non-heading ids -- we deliberately only track headings,
 *     so fragments are validated against the heading set only)
 *   - asset paths (anything ending in a file extension)
 *
 * Exits with code 0 if all internal links resolve. Exits with code 1 and
 * prints a grouped report otherwise.
 */
import { type Doc, getDoc, listDocSlugs } from "../lib/docs";

type Broken = {
  fromSlug: string;
  fromFilepath: string;
  href: string;
  reason: string;
};

function isExternal(href: string): boolean {
  return /^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:");
}

function looksLikeAsset(pathname: string): boolean {
  // Anything with a file-like extension (.png, .svg, .css, .js, .woff2, .md)
  // is treated as an asset, not a docs page. We only validate docs pages.
  return /\.[a-z0-9]{1,5}$/i.test(pathname);
}

/**
 * Map a slug ("", "cli/me-memory", ...) to the URL the rewriter produces:
 *   ""               -> "/"
 *   "cli/me-memory"  -> "/cli/me-memory/"
 */
function slugToUrl(slug: string): string {
  return slug === "" ? "/" : `/${slug}/`;
}

/**
 * Convert a URL pathname back to a slug:
 *   "/"                 -> ""
 *   "/cli/me-memory/"   -> "cli/me-memory"
 */
function urlToSlug(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Resolve a link href in the context of a source page slug. Returns the
 * `{ pathname, hash }` of the absolute target, or null if the href is
 * external or otherwise skippable.
 */
function resolveLink(
  href: string,
  fromSlug: string,
): { pathname: string; hash: string } | null {
  if (isExternal(href)) return null;
  if (href.length === 0) return null;

  // Pure fragment -> stays on current page.
  if (href.startsWith("#")) {
    return { pathname: slugToUrl(fromSlug), hash: href.slice(1) };
  }

  // Build a fake absolute base URL rooted at the source page so that
  // relative paths like "../formats/" resolve correctly.
  const baseUrl = `https://docs.invalid${slugToUrl(fromSlug)}`;
  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return null;
  }

  return {
    pathname: resolved.pathname,
    hash: resolved.hash.replace(/^#/, ""),
  };
}

async function checkAll(): Promise<Broken[]> {
  const slugs = await listDocSlugs();
  console.log(`[check-links] rendering ${slugs.length} pages…`);

  const docs: Doc[] = [];
  for (const slug of slugs) {
    docs.push(await getDoc(slug));
  }

  const headingsBySlug = new Map<string, Set<string>>();
  for (const doc of docs) {
    headingsBySlug.set(doc.slug, new Set(doc.headingIds));
  }

  const broken: Broken[] = [];

  for (const doc of docs) {
    for (const href of doc.linkHrefs) {
      const target = resolveLink(href, doc.slug);
      if (!target) continue; // external or unparseable -- skip

      const { pathname, hash } = target;

      // Asset path -- not a docs page, skip.
      if (looksLikeAsset(pathname)) continue;

      const targetSlug = urlToSlug(pathname);
      const targetHeadings = headingsBySlug.get(targetSlug);

      if (!targetHeadings) {
        broken.push({
          fromSlug: doc.slug,
          fromFilepath: doc.filepath,
          href,
          reason: `target page does not exist: ${pathname}`,
        });
        continue;
      }

      if (hash && !targetHeadings.has(hash)) {
        broken.push({
          fromSlug: doc.slug,
          fromFilepath: doc.filepath,
          href,
          reason: `anchor #${hash} does not exist on ${pathname}`,
        });
      }
    }
  }

  return broken;
}

async function main(): Promise<void> {
  const broken = await checkAll();

  if (broken.length === 0) {
    console.log("[check-links] all internal links resolve. ✓");
    return;
  }

  // Group by source page for a readable report.
  const bySource = new Map<string, Broken[]>();
  for (const b of broken) {
    const list = bySource.get(b.fromFilepath) ?? [];
    list.push(b);
    bySource.set(b.fromFilepath, list);
  }

  console.error(
    `\n[check-links] FAILED -- ${broken.length} broken link(s) in ${bySource.size} file(s):\n`,
  );
  for (const [filepath, links] of bySource) {
    console.error(`  ${filepath}`);
    for (const b of links) {
      console.error(`    - "${b.href}"  →  ${b.reason}`);
    }
    console.error("");
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("[check-links] error while checking:", err);
  process.exit(1);
});
