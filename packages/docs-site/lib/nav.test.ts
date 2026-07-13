/**
 * Guards against drift between the files under `docs/` and the hand-curated
 * sidebar in `nav.ts`.
 *
 * The docs site renders a standalone page for *every* `.md` file under
 * `docs/` (see `listDocSlugs`), but the sidebar only shows what's listed in
 * `NAV`. A page added without a matching nav entry is reachable by URL yet
 * invisible in navigation — exactly the drift that left several pages
 * orphaned. This test asserts both directions:
 *
 *   1. Every `.md` page on disk is present in the sidebar (or explicitly
 *      allowlisted). Catches: a new page that was never linked.
 *   2. Every sidebar slug resolves to a real `.md` file. Catches: a dead
 *      nav entry (page renamed/removed but the link lingered).
 *
 * Slugs are computed independently of cwd (relative to this file) so the
 * test is robust under `bun test` from any directory.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NAV_FLAT } from "./nav";

const DOCS_ROOT = resolve(import.meta.dir, "..", "..", "..", "docs");
const EXCLUDED_DIRS = new Set(["assets", "stylesheets"]);

/** Pages that render but are intentionally absent from the sidebar. */
const NAV_ALLOWLIST = new Set<string>([]);

/** Walk `docs/` and return every markdown slug (root index.md -> ""). */
function listDocSlugs(dir = DOCS_ROOT, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(
        ...listDocSlugs(
          join(dir, entry.name),
          prefix ? `${prefix}/${entry.name}` : entry.name,
        ),
      );
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const base = entry.name.replace(/\.md$/, "");
    if (prefix === "" && base === "index") {
      out.push("");
      continue;
    }
    out.push(prefix ? `${prefix}/${base}` : base);
  }
  return out;
}

const DISK_SLUGS = listDocSlugs();
const NAV_SLUGS = new Set(NAV_FLAT.map((item) => item.slug));

describe("nav ↔ docs parity", () => {
  test("sanity: found docs pages and nav entries", () => {
    expect(DISK_SLUGS.length).toBeGreaterThan(0);
    expect(NAV_SLUGS.size).toBeGreaterThan(0);
  });

  test("every docs page is in the sidebar (or allowlisted)", () => {
    const orphans = DISK_SLUGS.filter(
      (slug) => !NAV_SLUGS.has(slug) && !NAV_ALLOWLIST.has(slug),
    );
    expect(orphans).toEqual([]);
  });

  test("every sidebar entry resolves to a real docs page", () => {
    const diskSet = new Set(DISK_SLUGS);
    const dead = [...NAV_SLUGS].filter((slug) => !diskSet.has(slug));
    expect(dead).toEqual([]);
  });
});
