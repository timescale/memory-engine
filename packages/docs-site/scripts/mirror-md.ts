/**
 * Post-build raw Markdown mirror.
 *
 * Walks the source `docs/` tree at the repo root and copies every `.md`
 * file into the Next.js static export output (`out/`) at the matching
 * relative path. The result is that both `/foo/` (HTML) and `/foo.md`
 * (raw markdown) are served, preserving agent-friendly raw URLs.
 *
 * The home page maps `docs/index.md` -> `out/index.md` (also served at
 * `/index.md` and reachable via the home route).
 *
 * Runs after `next build` and `copy-assets.ts`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const PKG_ROOT = process.cwd();
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const OUT_ROOT = path.join(PKG_ROOT, "out");

const EXCLUDED_DIRS = new Set(["assets", "stylesheets"]);

async function walkAndCopy(src: string, rel: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const srcPath = path.join(src, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      count += await walkAndCopy(srcPath, relPath);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const destPath = path.join(OUT_ROOT, relPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
    count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  try {
    await fs.access(OUT_ROOT);
  } catch {
    throw new Error(
      `out/ not found at ${OUT_ROOT}. Run 'next build' before this script.`,
    );
  }
  const count = await walkAndCopy(DOCS_ROOT, "");
  console.log(`[mirror-md] mirrored ${count} markdown file(s) into out/`);
}

main().catch((err) => {
  console.error("[mirror-md] failed:", err);
  process.exit(1);
});
