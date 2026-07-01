/**
 * Reserved `$`-prefixed meta keys that link ordered memories into a thread,
 * plus the canonical memory-path builder used to write and resolve those links.
 *
 * Some memories form an ordered "thread" — transcript messages in a session, or
 * git commits in first-parent order. Reserved meta keys stitch them together:
 *
 *   - `$prev`   — canonical path of the previous memory in the thread. Set by the
 *                 conversation importers (previous message) and the git importer
 *                 (first-parent commit). By convention it is (almost) always set;
 *                 the thread head has none.
 *   - `$next`   — canonical path of the next memory. Optional and often absent
 *                 (unknown at the head of an incomplete/incremental import). It
 *                 MAY be stored, but neither importer does today — the web UI
 *                 derives it when absent (see below).
 *   - `$thread` — an opaque grouping id shared by every memory in a thread (the
 *                 conversation importers set it to the source session id). A
 *                 `meta @> {$thread}` containment search returns the whole thread.
 *                 The git importer does not set it.
 *
 * `$next` is derivable from `$prev`: the next memory is the one whose `$prev`
 * points back at this memory (`meta @> {$prev: <thisPath>}`, further constrained
 * by `$thread` when present). Because the derivation is an exact `@>` match on
 * the stored `$prev` string, the importer that WRITES a link and the UI that
 * resolves/derives it must produce byte-identical paths — always via
 * `memoryPath` below.
 */

/** Reserved meta key: canonical path of the previous memory in the thread. */
export const META_PREV = "$prev";
/** Reserved meta key: canonical path of the next memory (optional; often derived). */
export const META_NEXT = "$next";
/** Reserved meta key: opaque grouping id shared across a thread. */
export const META_THREAD = "$thread";

/**
 * Build the canonical leading-slash memory path from a `tree` and a leaf `name`
 * — e.g. (`share.projects.foo`, `msg_1`) → `/share/projects/foo/msg_1`, and
 * (``, `note`) at the root → `/note`.
 *
 * Mirrors the absolute form of `denormalizeTreePath` (dots → slashes, leading
 * `/`) so the result feeds straight back into `memory.getByPath`. Lenient on the
 * `tree` input: accepts either `.`- or `/`-separated trees, with or without
 * leading/trailing separators (segments are re-joined), matching the wire
 * contract's interchangeable separators.
 */
export function memoryPath(tree: string, name: string): string {
  const segments = tree.split(/[/.]+/).filter((s) => s.length > 0);
  segments.push(name);
  return `/${segments.join("/")}`;
}
