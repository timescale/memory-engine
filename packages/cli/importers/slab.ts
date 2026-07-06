/**
 * Slab knowledge-base importer — walks an unzipped Slab export (a directory of
 * markdown posts, one per post, nested in topic folders) and turns each `.md`
 * file into one memory under `<tree-root>.<topic>.<subtopic>...`.
 *
 * Unlike `me import memories`, which needs per-file frontmatter and otherwise
 * flattens everything into `share`, this importer derives the Memory Engine
 * fields from the filesystem layout the Slab export carries instead:
 *
 *   - tree      <treeRoot>.<topic>.<subtopic>...  (each directory segment
 *               slugified to an ltree label; topic-less posts sitting at the
 *               export root go under <treeRoot>.<uncategorizedNode>)
 *   - name      filename-derived leaf slug (keeping the `.md` extension),
 *               unique within its tree
 *   - content   the full markdown body, verbatim
 *   - meta      { title, source, slab_topic_path, original_filename,
 *                 importer_version } — deterministic, so a re-import is a
 *               content-aware-replace no-op and an importer_version bump
 *               re-renders every post in place
 *   - temporal  best-effort point-in-time parsed from a leading date in the
 *               filename (YYYY-MM-DD / YYYY.MM.DD / YYYYMMDD), else omitted
 *
 * Identity: a dated post seeds `id = uuidv7At(<date>)` so it sorts
 * chronologically by id; an undated post omits the id (server-generated v7).
 * Idempotency keys on `(tree, name)` regardless, so re-imports reconcile the
 * same rows. All builders here are pure (no RPC); the command layer
 * (commands/import-slab.ts) does auth, walking, batching, and rendering.
 */

import { basename, dirname, join } from "node:path";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import {
  extractMarkdownTitle,
  MAX_NAME_LEN,
  makeUniqueName,
  normalizeNameBase,
  normalizeTreeLabel,
  treeForRelativeDir,
} from "./markdown-files.ts";
import { uuidv7At } from "./uuid.ts";

// Re-exported so existing consumers (tests, slab-zip) keep importing the
// slot-arithmetic helpers from here; they now live in markdown-files.ts,
// shared with `me import docs`.
export { makeUniqueName, normalizeTreeLabel };

/** Default tree root for an import run (kept isolated + reversible). */
export const DEFAULT_SLAB_TREE_ROOT = "share.slab";

/** Default bucket label for topic-less posts at the export root. */
export const DEFAULT_UNCATEGORIZED_NODE = "uncategorized";

/**
 * Version tag stored in `meta.importer_version`. Bumping it makes meta differ,
 * so the server's content-aware `onConflict: "replace"` re-renders every
 * previously-imported post on the next run, propagating parser changes without
 * a manual wipe.
 */
export const SLAB_IMPORTER_VERSION = "1";

/**
 * Extension kept on each post's leaf name (so `tree/name` reads like a path to
 * the source `.md` file, e.g. `/share/slab/.../cloud-faq.md`). Appended after
 * slugification + collision-resolution, so the suffix stays before it.
 */
const NAME_EXT = ".md";

/** Max length of the extension-less base, leaving room for `NAME_EXT`. */
const NAME_BASE_MAX = MAX_NAME_LEN - NAME_EXT.length;

/**
 * Derive the extension-less base of a filename-like leaf name. The final name
 * is this base plus `NAME_EXT`, built in `buildSlabMemory` after collision
 * resolution; together they match `memoryNameSchema`
 * (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, <= 128 chars). The normalization rules
 * live in the shared `normalizeNameBase`.
 */
export function normalizeName(rawFilename: string): string {
  return normalizeNameBase(rawFilename.replace(/\.md$/i, ""), NAME_BASE_MAX);
}

/** First `# H1` heading, else the filename without extension (emoji/case intact). */
export function extractTitle(content: string, rawFilename: string): string {
  return extractMarkdownTitle(content, rawFilename.replace(/\.md$/i, ""));
}

/**
 * Best-effort point-in-time from a leading date token in the filename.
 * Accepts `YYYY-MM-DD`, `YYYY.MM.DD`, and `YYYYMMDD` prefixes; returns an ISO
 * UTC-midnight `start`, or undefined when there's no valid leading date.
 */
export function parseTemporalFromFilename(
  rawFilename: string,
): { start: string } | undefined {
  const base = rawFilename.replace(/\.md$/i, "");
  const m = base.match(/^(\d{4})[-.]?(\d{2})[-.]?(\d{2})\b/);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1990 || year > 2100) return undefined;
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > 31) return undefined;
  // Validate the calendar date (rejects e.g. 2023-02-30).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { start: dt.toISOString().replace(/\.\d{3}Z$/, "Z") };
}

/** Context shared by every memory built in one import run. */
export interface SlabMemoryContext {
  /** Tree root (ltree-safe, no trailing dot). Default: share.slab. */
  treeRoot: string;
  /** Bucket label for topic-less posts at the export root. */
  uncategorizedNode: string;
  /** When false, skip filename-date parsing (no temporal). */
  parseTemporal: boolean;
  /** Within-run name registry for `(tree, name)` uniqueness. */
  usedNames: Map<string, Set<string>>;
}

/**
 * Build `<treeRoot>.<...>` from a post's directory, relative to the export root
 * (posix-joined, "" for a root-level post). Root-level posts go under the
 * uncategorized bucket.
 */
export function treeForDir(relDir: string, ctx: SlabMemoryContext): string {
  if (relDir === "" || relDir === ".") {
    return `${ctx.treeRoot}.${ctx.uncategorizedNode}`;
  }
  return treeForRelativeDir(ctx.treeRoot, relDir);
}

/**
 * Build the memory payload for one Slab post. `relPath` is the file path
 * relative to the export root (so its dirname is the topic path); `content` is
 * the raw file body. Returns a `MemoryCreateParams` ready for batchCreate.
 */
export function buildSlabMemory(
  relPath: string,
  content: string,
  ctx: SlabMemoryContext,
): MemoryCreateParams {
  const rawFilename = basename(relPath);
  const dir = dirname(relPath);
  const relDir = dir === "." ? "" : dir;

  const tree = treeForDir(relDir, ctx);
  // Dedup on the extension-less base (so a collision suffix lands before the
  // extension: `plan-2.md`, not `plan.md-2`), then re-attach `.md`.
  const base = makeUniqueName(
    tree,
    normalizeName(rawFilename),
    ctx.usedNames,
    NAME_BASE_MAX,
  );
  const name = `${base}${NAME_EXT}`;
  const title = extractTitle(content, rawFilename);

  const meta: Record<string, unknown> = {
    title,
    source: "slab",
    slab_topic_path: relDir.split(/[\\/]+/).join("/"),
    original_filename: rawFilename,
    importer_version: SLAB_IMPORTER_VERSION,
  };

  const temporal = ctx.parseTemporal
    ? parseTemporalFromFilename(rawFilename)
    : undefined;

  return {
    // A dated post seeds a date-prefixed v7 so it sorts chronologically by id;
    // undated posts omit the id and get a server-generated v7. Either way the
    // (tree, name) key drives idempotency.
    ...(temporal ? { id: uuidv7At(Date.parse(temporal.start)) } : {}),
    content,
    tree,
    name,
    meta,
    ...(temporal ? { temporal } : {}),
  };
}

/** One discovered Slab post: its path relative to the export root + body. */
export interface SlabFile {
  relPath: string;
  content: string;
}

/**
 * Walk an export directory, yielding `{relPath, content}` for each non-empty
 * `.md` file in sorted order (sorted so name disambiguation and id assignment
 * are deterministic across runs). Empty files are skipped — there is nothing to
 * embed and the engine rejects empty content.
 */
export async function* walkSlabDir(dir: string): AsyncIterable<SlabFile> {
  const glob = new Bun.Glob("**/*.md");
  const rel: string[] = [];
  for await (const f of glob.scan({ cwd: dir, absolute: false })) {
    rel.push(f);
  }
  rel.sort();
  for (const relPath of rel) {
    const content = (await Bun.file(join(dir, relPath)).text()).trim();
    if (content.length === 0) continue;
    yield { relPath, content };
  }
}
