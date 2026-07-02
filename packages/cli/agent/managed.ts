/**
 * Managed-block + managed-file helpers for harness integrations.
 *
 * Every artifact the integrations write is either:
 *   - a whole file we own (identified by a managed marker in its content),
 *   - a marker-delimited block inside a shared text file (markdown context
 *     files, `.env` files, TOML configs, git hooks), or
 *   - a set of owned keys inside a shared JSON config.
 *
 * This module is the single implementation of that discipline: upserts replace
 * in place (idempotent — re-runs never grow the file), removals restore the
 * file to its unmanaged content, and everything is pure/string-level so it
 * unit-tests without I/O. File-level wrappers layer the read/write on top.
 *
 * Two marker styles cover every format we touch:
 *   - HTML-comment markers for markdown (`<!-- ... -->`)
 *   - hash-comment markers for sh / dotenv / TOML (`# ...`)
 *
 * Markers embed the *managing command* (e.g. `me init`), NOT the harness name:
 * shared artifacts (the project `AGENTS.md` block, `.agents/skills/`) are
 * written identically by every harness's command, and the second harness must
 * recognize the first one's block as its own.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// =============================================================================
// Markers
// =============================================================================

/** Start/end delimiters of a managed block. */
export interface BlockMarkers {
  start: string;
  end: string;
}

/** Markdown (HTML-comment) markers, e.g. for CLAUDE.md / AGENTS.md blocks. */
export function markdownMarkers(managedBy: string): BlockMarkers {
  return {
    start: `<!-- >>> memory-engine (managed by \`${managedBy}\`) >>> -->`,
    end: "<!-- <<< memory-engine <<< -->",
  };
}

/** Hash-comment markers, e.g. for `.env`, TOML, and shell-script blocks. */
export function hashMarkers(managedBy: string): BlockMarkers {
  return {
    start: `# >>> memory-engine (managed by \`${managedBy}\`) >>>`,
    end: "# <<< memory-engine <<<",
  };
}

// =============================================================================
// Pure block operations
// =============================================================================

/** Wrap body lines in the markers, ending with a newline. */
export function renderBlock(markers: BlockMarkers, body: string[]): string {
  return [markers.start, ...body, markers.end, ""].join("\n");
}

/** Whether the content carries a managed block (by its start marker). */
export function hasBlock(existing: string, markers: BlockMarkers): boolean {
  return existing.includes(markers.start);
}

/**
 * Upsert `block` (a full {@link renderBlock} rendering) into `existing`
 * content. If the start marker is present the block is replaced in place;
 * otherwise it is appended with one blank line of separation. `null` existing
 * means "no file yet" — the block becomes the whole content.
 */
export function upsertBlock(
  existing: string | null,
  block: string,
  markers: BlockMarkers,
): string {
  if (existing === null || existing.trim().length === 0) return block;
  const start = existing.indexOf(markers.start);
  if (start !== -1) {
    const endMarker = existing.indexOf(markers.end, start);
    const end =
      endMarker === -1 ? existing.length : endMarker + markers.end.length;
    // Swallow a single trailing newline after the old block so re-runs don't
    // grow the file.
    const tail = existing[end] === "\n" ? end + 1 : end;
    return existing.slice(0, start) + block + existing.slice(tail);
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

/**
 * Remove the managed block. Returns the remaining content, or `null` when
 * nothing meaningful would remain (only blank lines, or only lines accepted by
 * `boilerplate` — e.g. a shebang) so the caller can delete the file.
 */
export function removeBlock(
  existing: string,
  markers: BlockMarkers,
  boilerplate: (line: string) => boolean = () => false,
): string | null {
  const start = existing.indexOf(markers.start);
  if (start === -1) return existing;
  const endMarker = existing.indexOf(markers.end, start);
  const end =
    endMarker === -1 ? existing.length : endMarker + markers.end.length;
  const tail = existing[end] === "\n" ? end + 1 : end;
  const remaining = existing.slice(0, start) + existing.slice(tail);
  const meaningful = remaining
    .split("\n")
    .filter((l) => l.trim().length > 0 && !boilerplate(l.trim()));
  return meaningful.length === 0 ? null : remaining;
}

// =============================================================================
// File-level wrappers
// =============================================================================

/** Outcome of a file-level upsert/remove, for user-facing reporting. */
export type UpsertOutcome = "installed" | "updated" | "unchanged";
export type RemoveOutcome = "removed" | "absent";

/**
 * Upsert a managed block into the file at `path` (creating parent dirs and the
 * file as needed). Returns whether the block was newly installed, refreshed,
 * or already up to date.
 */
export async function upsertBlockInFile(
  path: string,
  block: string,
  markers: BlockMarkers,
): Promise<UpsertOutcome> {
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // no file yet
  }
  const had = existing !== null && hasBlock(existing, markers);
  const next = upsertBlock(existing, block, markers);
  if (existing !== null && next === existing) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return had ? "updated" : "installed";
}

/**
 * Remove the managed block from the file at `path`. Deletes the file when
 * nothing meaningful remains (per `boilerplate` — see {@link removeBlock}).
 */
export async function removeBlockFromFile(
  path: string,
  markers: BlockMarkers,
  boilerplate?: (line: string) => boolean,
): Promise<RemoveOutcome> {
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    return "absent";
  }
  if (!hasBlock(existing, markers)) return "absent";
  const remaining = removeBlock(existing, markers, boilerplate);
  if (remaining === null) await unlink(path);
  else await writeFile(path, remaining);
  return "removed";
}

// =============================================================================
// Managed whole files
// =============================================================================

/**
 * Write a whole managed file (creating parent dirs). The content must carry a
 * recognizable marker so {@link managedFileInstalled} and re-runs can identify
 * it as ours. Refuses to overwrite a file that exists but does NOT carry the
 * marker (someone else's file) unless `force` is set.
 */
export async function writeManagedFile(
  path: string,
  content: string,
  marker: string,
  opts: { force?: boolean } = {},
): Promise<UpsertOutcome> {
  if (!content.includes(marker)) {
    throw new Error(`managed file content is missing its marker: ${path}`);
  }
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // no file yet
  }
  if (existing !== null && !existing.includes(marker) && !opts.force) {
    throw new Error(
      `${path} exists but is not managed by me (missing marker) — refusing to overwrite`,
    );
  }
  if (existing === content) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return existing === null ? "installed" : "updated";
}

/** Whether the file exists and carries the managed marker. */
export async function managedFileInstalled(
  path: string,
  marker: string,
): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).includes(marker);
  } catch {
    return false;
  }
}

/** Remove a managed file (only when it carries the marker). */
export async function removeManagedFile(
  path: string,
  marker: string,
): Promise<RemoveOutcome> {
  if (!(await managedFileInstalled(path, marker))) return "absent";
  await unlink(path);
  return "removed";
}

// =============================================================================
// Managed JSON keys
// =============================================================================

/** Read a JSON object file; `null` when absent; throws on unparseable. */
export async function readJsonFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Update a JSON object file in place: read (or start from `{}`), apply
 * `mutate`, write pretty-printed. `mutate` may return a replacement object or
 * mutate its argument. Preserves all keys it doesn't touch.
 */
export async function updateJsonFile(
  path: string,
  mutate: (
    config: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
): Promise<void> {
  const existing = (await readJsonFile(path)) ?? {};
  const next = mutate(existing) ?? existing;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
}
