import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { renderMarkdown, type TocEntry } from "./markdown";

/**
 * Absolute path of the source `docs/` directory at the repo root.
 *
 * We resolve from `process.cwd()`, which Next.js sets to the package
 * root (`packages/docs-site/`) during both `next dev` and `next build`.
 * From there, `docs/` lives two levels up at the repo root.
 */
export const DOCS_ROOT = path.resolve(process.cwd(), "..", "..", "docs");

const EXCLUDED_DIRS = new Set(["assets", "stylesheets"]);

export type Doc = {
  slug: string;
  filepath: string;
  title: string;
  description: string | null;
  html: string;
  toc: TocEntry[];
  /** Every heading id rendered on the page (used by the link checker). */
  headingIds: string[];
  /** Every outbound `<a href>` value on the page (post link rewriting). */
  linkHrefs: string[];
};

/**
 * Walk `docs/` recursively and return every Markdown file's slug.
 *
 * The slug is the relative path under `docs/` with the `.md` extension
 * stripped. The home page (docs/index.md) maps to the empty slug "".
 */
export async function listDocSlugs(): Promise<string[]> {
  const out: string[] = [];
  await walk(DOCS_ROOT, "", out);
  return out;
}

async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(
        path.join(dir, entry.name),
        prefix ? `${prefix}/${entry.name}` : entry.name,
        out,
      );
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const baseName = entry.name.replace(/\.md$/, "");
    if (prefix === "" && baseName === "index") {
      out.push("");
      continue;
    }
    out.push(prefix ? `${prefix}/${baseName}` : baseName);
  }
}

/**
 * Resolve a slug back to the absolute filepath of its source markdown.
 */
function slugToFilepath(slug: string): string {
  if (slug === "") return path.join(DOCS_ROOT, "index.md");
  return path.join(DOCS_ROOT, `${slug}.md`);
}

const docCache = new Map<string, Doc>();

/**
 * Read, parse, and render a single markdown page.
 */
export async function getDoc(slug: string): Promise<Doc> {
  const cached = docCache.get(slug);
  if (cached) return cached;

  const filepath = slugToFilepath(slug);
  const raw = await fs.readFile(filepath, "utf8");
  const parsed = matter(raw);
  const source = parsed.content;
  const { html, toc, headingIds, linkHrefs } = await renderMarkdown(
    source,
    slug,
  );

  // Title precedence: frontmatter -> first h1 in TOC pass (we'd need an
  // extra walk; instead we extract from the source heuristically).
  const titleFromFrontmatter =
    typeof parsed.data.title === "string" ? parsed.data.title : null;
  const titleFromHeading = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const title =
    titleFromFrontmatter ?? titleFromHeading ?? slug.split("/").pop() ?? "";
  const description =
    typeof parsed.data.description === "string"
      ? parsed.data.description
      : null;

  const doc: Doc = {
    slug,
    filepath,
    title,
    description,
    html,
    toc,
    headingIds,
    linkHrefs,
  };
  docCache.set(slug, doc);
  return doc;
}
