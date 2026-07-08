/**
 * Directory markdown-docs importer — walks a directory of markdown files
 * (git-enhanced when the directory is inside a work tree; see git-files.ts)
 * and turns each file into one memory under `<project-tree>.docs.<dirs>`,
 * mirroring the directory layout as the tree.
 *
 * Unlike `me import memories`, frontmatter here is NEVER interpreted as
 * engine fields (id/name/tree/temporal) — real-world docs own their
 * frontmatter vocabulary (Docusaurus `id:`, Hugo `slug:`), and the engine
 * fields are derived from the file path so they stay stable idempotency
 * keys. The parsed frontmatter object is preserved verbatim under
 * `meta.doc`:
 *
 *   - tree      <docsTree>.<relative dirs slugified>  (root files sit at
 *               <docsTree> itself; paths are relative to the import root)
 *   - name      filename-derived leaf slug keeping the (lowercased)
 *               extension, unique within its tree
 *   - content   the body with frontmatter stripped (it lives in meta.doc);
 *               `.mdx` additionally drops top-level import/export statement
 *               lines (outside code fences); capped at DOC_BODY_BYTES_CAP
 *   - meta      { title, source: "docs", repo_path, importer_version,
 *                 doc?, truncated? } — deterministic, so a re-import is a
 *               content-aware-replace no-op and an importer_version bump
 *               re-renders every doc in place
 *   - temporal  the `--temporal-key` frontmatter value when given and
 *               parseable, else the file's git last-modified date (absent
 *               in plain-directory mode / shallow clones / uncommitted
 *               files — never filesystem mtime, which churns on clone and
 *               would break replace-no-op idempotency)
 *
 * Identity: a dated doc seeds `id = uuidv7At(<date>)` so docs sort by
 * recency on the id; an undated doc omits the id. `(tree, name)` keys
 * idempotency regardless, and on conflict the existing row's id is kept —
 * id order is recency-at-first-ingest, temporal is live recency.
 *
 * All builders here are pure (no RPC); the command layer
 * (commands/import-docs.ts) does auth, discovery, batching, and rendering.
 */

import { basename, dirname, extname } from "node:path";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { parse as yamlParse } from "yaml";
import { splitFrontmatterBlock } from "../parsers/frontmatter.ts";
import { truncateUtf8 } from "./git.ts";
import {
  extractMarkdownTitle,
  MAX_NAME_LEN,
  makeUniqueName,
  normalizeNameBase,
  treeForRelativeDir,
} from "./markdown-files.ts";
import { uuidv7At } from "./uuid.ts";

/** Per-project tree node holding imported docs (next to git_history). */
export const DOCS_NODE_NAME = "docs";

/**
 * `meta.source` stamp on every imported doc — the ownership scope `--prune`
 * reconciles against (rows without it are never touched).
 */
export const DOCS_META_SOURCE = "docs";

/**
 * Version tag stored in `meta.importer_version`. Bumping it makes meta
 * differ, so the server's content-aware `onConflict: "replace"` re-renders
 * every previously-imported doc on the next run.
 */
export const DOCS_IMPORTER_VERSION = "1";

/**
 * Default include patterns. `.mdx` is deliberately in: Docusaurus-style
 * repos are the flagship use case, and excluding it by default reads as a
 * silent coverage gap ("only 40 of my 300 pages imported"). Opt out with an
 * `--exclude` glob.
 */
export const DEFAULT_DOC_PATTERNS = ["**/*.md", "**/*.markdown", "**/*.mdx"];

/** Max content bytes per doc memory before truncation (marker appended). */
export const DOC_BODY_BYTES_CAP = 64 * 1024;

/**
 * Directory names pruned from the plain-directory walk, which has no
 * gitignore to lean on. Hidden files/dirs (including `.git`) are already
 * excluded by the scanner's dot rule.
 */
const PLAIN_EXCLUDED_DIRS = new Set(["node_modules"]);

/** Context shared by every memory built in one import run. */
export interface DocsMemoryContext {
  /** Full docs root: `<project-tree>.<DOCS_NODE_NAME>` (ltree-safe). */
  docsTree: string;
  /**
   * Frontmatter key whose value becomes the temporal start (`--temporal-key`).
   * Falls back to the file's git last-modified date when absent/unparseable.
   */
  temporalKey?: string;
  /** When false (`--no-temporal`), no temporal and no id seeding. */
  parseTemporal: boolean;
  /** Within-run name registry for `(tree, name)` uniqueness. */
  usedNames: Map<string, Set<string>>;
}

/** Lenient frontmatter split for documents (never throws). */
export interface DocFrontmatter {
  /** Parsed frontmatter object; undefined when absent, invalid, or non-object. */
  doc?: Record<string, unknown>;
  /**
   * The content body. When frontmatter parsed cleanly this is everything
   * after the closing fence; when the block was invalid YAML or a
   * non-object, it is the ORIGINAL input, fence included — a broken header
   * stays part of the content rather than being dropped. Either way this is
   * the PRE-processing body: buildDocMemory still trims it, strips mdx
   * statements, and applies the byte cap before it becomes content.
   */
  body: string;
}

/**
 * Split + parse a document's YAML frontmatter, leniently. Docs toolchains
 * own this vocabulary — a bad block downgrades to "no frontmatter" rather
 * than erroring (contrast parsers/markdown.ts, where frontmatter is the
 * memory record and a bad block is a hard per-file error).
 */
export function parseDocFrontmatter(input: string): DocFrontmatter {
  const block = splitFrontmatterBlock(input);
  if (!block) return { body: input };
  try {
    const parsed: unknown = yamlParse(block.yaml);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      !(parsed instanceof Date)
    ) {
      return { doc: parsed as Record<string, unknown>, body: block.body };
    }
  } catch {
    // fall through — treat as content
  }
  return { body: input };
}

/**
 * Drop top-level single-line `import …` / `export …` statement lines from
 * an `.mdx` body — the highest-noise, lowest-information lines (module
 * paths, component wiring). Lines inside fenced code blocks are kept:
 * usage examples legitimately contain import statements. JSX component
 * tags are also kept — structurally the same tolerable noise as raw HTML
 * in `.md`. A multi-line import statement only loses its first line
 * (accepted edge; rare in docs MDX).
 */
export function stripMdxStatements(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && /^(import|export)\s/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The temporal for one doc: the designated frontmatter key when set and
 * parseable (works without git — shallow clones and plain dirs included),
 * else the git last-modified date, else none. `--no-temporal` disables both.
 */
export function deriveDocTemporal(
  doc: Record<string, unknown> | undefined,
  lastModifiedIso: string | undefined,
  ctx: DocsMemoryContext,
): { start: string } | undefined {
  if (!ctx.parseTemporal) return undefined;
  if (ctx.temporalKey && doc) {
    const v = doc[ctx.temporalKey];
    const ms =
      v instanceof Date
        ? v.getTime()
        : typeof v === "string"
          ? Date.parse(v)
          : Number.NaN;
    if (!Number.isNaN(ms)) return { start: new Date(ms).toISOString() };
  }
  if (lastModifiedIso !== undefined) {
    const ms = Date.parse(lastModifiedIso);
    if (!Number.isNaN(ms)) return { start: new Date(ms).toISOString() };
  }
  return undefined;
}

/** A recognized, lowercased file extension (".md"), or "" when unusable. */
function docExt(rawFilename: string): string {
  const ext = extname(rawFilename).toLowerCase();
  return /^\.[a-z0-9]+$/.test(ext) ? ext : "";
}

/**
 * Build the memory payload for one doc, or null when the body is empty
 * after frontmatter/statement stripping (nothing to embed — the engine
 * rejects empty content). `relPath` is relative to the import root;
 * `lastModifiedIso` is the git last-modified date when known.
 */
export function buildDocMemory(
  relPath: string,
  rawContent: string,
  lastModifiedIso: string | undefined,
  ctx: DocsMemoryContext,
): MemoryCreateParams | null {
  const rawFilename = basename(relPath);
  const ext = docExt(rawFilename);
  const bareName =
    ext.length > 0 ? rawFilename.slice(0, -ext.length) : rawFilename;

  const { doc, body } = parseDocFrontmatter(rawContent);
  let content = (ext === ".mdx" ? stripMdxStatements(body) : body).trim();
  if (content.length === 0) return null;
  const capped = truncateUtf8(content, DOC_BODY_BYTES_CAP);
  const truncated = capped !== content;
  content = capped;

  const dir = dirname(relPath);
  const tree = treeForRelativeDir(ctx.docsTree, dir === "." ? "" : dir);

  // Dedup on the extension-less base (so a collision suffix lands before the
  // extension: `setup-2.md`, not `setup.md-2`), then re-attach the extension.
  const baseMax = MAX_NAME_LEN - ext.length;
  const base = makeUniqueName(
    tree,
    normalizeNameBase(bareName, baseMax),
    ctx.usedNames,
    baseMax,
  );
  const name = `${base}${ext}`;

  // Frontmatter `title:` wins over the first-H1 heuristic — that's using
  // frontmatter as data about the doc, not as an engine directive.
  const fmTitle =
    typeof doc?.title === "string" && doc.title.trim().length > 0
      ? doc.title.trim()
      : undefined;
  const title = fmTitle ?? extractMarkdownTitle(content, bareName);

  const temporal = deriveDocTemporal(doc, lastModifiedIso, ctx);

  const meta: Record<string, unknown> = {
    title,
    source: DOCS_META_SOURCE,
    repo_path: relPath.split(/[\\/]+/).join("/"),
    importer_version: DOCS_IMPORTER_VERSION,
  };
  if (doc !== undefined) meta.doc = doc;
  if (truncated) meta.truncated = true;

  return {
    // A dated doc seeds a date-prefixed v7 so docs sort by recency on the id;
    // undated docs omit the id (server-generated v7). Either way the
    // (tree, name) key drives idempotency.
    ...(temporal ? { id: uuidv7At(Date.parse(temporal.start)) } : {}),
    content,
    tree,
    name,
    meta,
    ...(temporal ? { temporal } : {}),
  };
}

/**
 * Filter discovered paths to the doc set: any include glob, no exclude
 * glob — applied CLIENT-SIDE in both discovery modes so `--include` /
 * `--exclude` mean exactly the same thing with and without git. Sorted, so
 * name disambiguation and id assignment are deterministic across runs.
 */
export function filterDocPaths(
  paths: string[],
  include: string[] = DEFAULT_DOC_PATTERNS,
  exclude: string[] = [],
): string[] {
  const inc = include.map((p) => new Bun.Glob(p));
  const exc = exclude.map((p) => new Bun.Glob(p));
  return paths
    .filter((p) => inc.some((g) => g.match(p)) && !exc.some((g) => g.match(p)))
    .sort();
}

/**
 * Walk a plain (non-git) directory, returning file paths relative to it.
 * Hidden files/dirs are excluded by the scanner's dot rule, plus the
 * PLAIN_EXCLUDED_DIRS names — there's no gitignore to lean on here.
 * Callers filter with `filterDocPaths`.
 */
export async function discoverPlainFiles(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const out: string[] = [];
  for await (const p of glob.scan({ cwd: dir, absolute: false, dot: false })) {
    const segments = p.split(/[\\/]+/);
    if (segments.some((s) => PLAIN_EXCLUDED_DIRS.has(s))) continue;
    out.push(p);
  }
  return out;
}
