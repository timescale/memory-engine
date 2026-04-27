/**
 * Post-build asset copier.
 *
 * Copies the following from the source `docs/` tree at the repo root into
 * the Next.js static export output (`out/`):
 *
 * - `docs/assets/`  -> `out/assets/`        (images, logos, fonts referenced
 *                                            by markdown content)
 * - `docs/CNAME`    -> `out/CNAME`          (GitHub Pages custom domain)
 * - `docs/agents.txt` -> `out/agents.txt`   (canonical agent guidance,
 *                                            also proxied by memory.build)
 *
 * Runs after `next build` from the package directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const PKG_ROOT = process.cwd();
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const OUT_ROOT = path.join(PKG_ROOT, "out");

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function copyFileIfExists(src: string, dest: string): Promise<boolean> {
  try {
    await fs.access(src);
  } catch {
    return false;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  return true;
}

async function main(): Promise<void> {
  // Confirm the build output exists.
  try {
    await fs.access(OUT_ROOT);
  } catch {
    throw new Error(
      `out/ not found at ${OUT_ROOT}. Run 'next build' before this script.`,
    );
  }

  let copied = 0;
  let dirs = 0;

  // Copy docs/assets/
  const assetsSrc = path.join(DOCS_ROOT, "assets");
  const assetsDest = path.join(OUT_ROOT, "assets");
  try {
    await fs.access(assetsSrc);
    await copyDir(assetsSrc, assetsDest);
    dirs += 1;
  } catch {
    // No assets/ directory -- skip silently.
  }

  // Copy docs/CNAME
  if (
    await copyFileIfExists(
      path.join(DOCS_ROOT, "CNAME"),
      path.join(OUT_ROOT, "CNAME"),
    )
  ) {
    copied += 1;
  }

  // Copy docs/agents.txt (verbatim, served at /agents.txt)
  if (
    await copyFileIfExists(
      path.join(DOCS_ROOT, "agents.txt"),
      path.join(OUT_ROOT, "agents.txt"),
    )
  ) {
    copied += 1;
  }

  // GitHub Pages disables Jekyll-style underscore-prefixed paths unless
  // `.nojekyll` is present. Next.js emits `_next/` so we MUST add this.
  await fs.writeFile(path.join(OUT_ROOT, ".nojekyll"), "");
  copied += 1;

  console.log(
    `[copy-assets] copied ${copied} file(s), ${dirs} directory tree(s) into out/`,
  );
}

main().catch((err) => {
  console.error("[copy-assets] failed:", err);
  process.exit(1);
});
