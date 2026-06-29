/**
 * Zip-source handling for `me import slab`.
 *
 * The command accepts either an unzipped export directory or the raw `.zip`.
 * For a zip we extract its markdown into a temp directory and then run the
 * exact same directory walk (`walkSlabDir`) — so the zip path reuses all of the
 * directory path's tree/name/meta derivation with no parallel logic.
 *
 * Extraction uses `fflate` (pure-JS, zero-dep) rather than shelling out to a
 * system `unzip`: the CLI ships a `bun build --compile` binary for Windows as
 * well as linux/darwin, and fflate bundles into that binary and runs on every
 * target. Slab exports are small (~tens of MB), so a synchronous in-memory
 * inflate is fine.
 */

import { readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

/** Local zip-file header magic (`PK\x03\x04`). */
const ZIP_LOCAL_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Empty-archive end-of-central-directory magic (`PK\x05\x06`). */
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06];

/** A resolved import source: a directory to walk plus a cleanup hook. */
export interface ResolvedSource {
  /** Directory to hand to `walkSlabDir` (the source itself, or a temp dir). */
  dir: string;
  /** Remove any temp extraction dir. A no-op for a plain directory source. */
  cleanup: () => Promise<void>;
}

/**
 * True when `path` is a zip archive: a regular file whose first bytes are the
 * zip magic. The first-bytes sniff (not just the extension) means a correctly
 * shaped export is detected even without a `.zip` name, and a misnamed
 * non-archive is rejected early.
 */
export async function isZipSource(path: string): Promise<boolean> {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    return false;
  }
  if (!isFile) return false;
  const fd = Bun.file(path);
  const head = new Uint8Array(await fd.slice(0, 4).arrayBuffer());
  if (head.length < 4) return false;
  return (
    ZIP_LOCAL_MAGIC.every((b, i) => head[i] === b) ||
    ZIP_EMPTY_MAGIC.every((b, i) => head[i] === b)
  );
}

/**
 * Recover a zip entry's UTF-8 filename.
 *
 * `fflate` decodes entry names as latin1 when the archive doesn't set the
 * UTF-8 flag (general-purpose bit 11) — which many zippers, including macOS
 * `zip`, omit even for UTF-8 names. That mojibakes non-ASCII filenames (e.g.
 * `…📒.md` → `…ð\x9f\x93\x92.md`, `—` → `â\x80\x94`). We reinterpret each char
 * as a raw byte and decode it as UTF-8; if the bytes aren't valid UTF-8 the
 * name was already correct (pure ASCII, or a genuine latin1 name), so we keep
 * it. Pure-ASCII names short-circuit unchanged.
 */
export function decodeZipName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
  if (/^[\x00-\x7f]*$/.test(name)) return name;
  const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return name;
  }
}

/** Reject zip entries that try to escape the destination (zip-slip). */
function isSafeEntryName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  // Normalize separators and reject any `..` segment.
  const segments = name.split(/[\\/]+/);
  return !segments.includes("..");
}

/**
 * Extract the `.md` files from `zipPath` into `destDir`, preserving their
 * relative paths. Non-markdown entries and directory entries are skipped — the
 * importer only reads markdown, and images are not rehosted, so there is no
 * reason to spill the rest of the archive to disk. Entries that would escape
 * `destDir` are rejected (zip-slip). Returns the number of files written.
 */
export async function extractSlabZip(
  zipPath: string,
  destDir: string,
): Promise<number> {
  const bytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read zip ${zipPath}: ${msg}`);
  }

  const destRoot = resolve(destDir);
  let written = 0;
  for (const [rawName, data] of Object.entries(entries)) {
    if (rawName.endsWith("/")) continue; // directory entry
    // Recover the real UTF-8 name before it reaches the filesystem, so the
    // re-read name (and thus meta.title/original_filename) isn't mojibake.
    const name = decodeZipName(rawName);
    if (!/\.md$/i.test(name)) continue; // markdown only
    if (!isSafeEntryName(name)) {
      throw new Error(`Unsafe path in zip (rejected): ${JSON.stringify(name)}`);
    }
    const target = resolve(destRoot, name);
    // Defense in depth: the resolved target must stay within destRoot.
    if (target !== destRoot && !target.startsWith(destRoot + sep)) {
      throw new Error(`Unsafe path in zip (rejected): ${JSON.stringify(name)}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    written++;
  }
  return written;
}

/**
 * If `dir` contains exactly one visible entry and it is a directory, return that
 * inner directory; otherwise return `dir` unchanged. Slab zips commonly wrap the
 * whole export in a single top-level folder; stripping it keeps topics at
 * `<tree-root>.<topic>` instead of `<tree-root>.<wrapper>.<topic>`.
 *
 * Deliberately strips only ONE level: a single wrapper is the real-world case,
 * and recursing further would collapse a legitimate single top-level topic (or a
 * topic with one subtopic) and lose its label. macOS archive cruft (`__MACOSX`,
 * dotfiles) is ignored when deciding whether the wrapper stands alone.
 */
export function descendLoneWrapper(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return dir;
  }
  const visible = entries.filter((e) => e !== "__MACOSX" && !e.startsWith("."));
  if (visible.length !== 1) return dir;
  const only = join(dir, visible[0] as string);
  try {
    if (!statSync(only).isDirectory()) return dir;
  } catch {
    return dir;
  }
  return only;
}

/**
 * Resolve an import source (a directory or a `.zip`) to a directory to walk.
 *
 * A directory passes through with a no-op cleanup. A zip is extracted into a
 * fresh temp directory; the returned `cleanup` removes it (the caller runs it in
 * a `finally`). After extraction a lone wrapper directory is stripped so topics
 * map directly under the tree root.
 */
export async function resolveSlabSource(
  source: string,
): Promise<ResolvedSource> {
  if (await isZipSource(source)) {
    const tempDir = await mkdtemp(join(tmpdir(), "me-slab-"));
    const cleanup = () => rm(tempDir, { recursive: true, force: true });
    try {
      await extractSlabZip(source, tempDir);
    } catch (error) {
      await cleanup();
      throw error;
    }
    return { dir: descendLoneWrapper(tempDir), cleanup };
  }

  // Not a zip: must be an existing directory.
  let isDir = false;
  try {
    isDir = statSync(source).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`Not a directory or .zip file: ${source}`);
  }
  return { dir: source, cleanup: async () => {} };
}
