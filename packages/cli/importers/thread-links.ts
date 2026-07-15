/**
 * Thread-link stamping for the conversation importers.
 *
 * A session's surviving messages form an ordered thread. This stamps the
 * reserved link keys onto each message payload's `meta`:
 *   - `$thread` — the session id, on every message (the grouping key; a
 *     `meta @> {$thread}` search returns the whole session).
 *   - `$prev`   — the canonical path of the previous surviving message, on all
 *     but the first.
 *
 * `$next` is intentionally not stored — the UI derives it from `$prev` (the
 * message whose `$prev` points back at this one).
 *
 * Call this once the surviving order is final (after skip + dedup) and before
 * any incremental suffix-narrowing: it stamps the full ordered list, so a
 * later-submitted suffix still carries a `$prev` pointing at its predecessor's
 * stable `(tree, name)` path — which is deterministic across re-imports, unlike
 * the re-minted row id.
 */

import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import {
  META_PREV,
  META_THREAD,
  memoryPath,
} from "@memory.build/protocol/meta";

export interface ThreadLinkOptions {
  /**
   * Canonical `home.<principal>` prefix used to make links under `~` stable
   * across readers. Stored meta must not contain caller-relative `~` paths.
   */
  homePrefix?: string;
}

function linkedMemoryPath(
  tree: string,
  name: string,
  opts: ThreadLinkOptions,
): string {
  const normalized = tree
    .replace(/\//g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  if (normalized === "~" || normalized.startsWith("~.")) {
    const homeTree = opts.homePrefix
      ? `${opts.homePrefix}${normalized.slice(1)}`
      : normalized;
    return memoryPath(homeTree, name);
  }
  return memoryPath(tree, name);
}

/**
 * Stamp `$thread` on every payload and `$prev` on all but the first, in the
 * given order. Mutates each payload's `meta` in place.
 */
export function stampConversationLinks(
  payloads: MemoryCreateParams[],
  threadId: string,
  opts: ThreadLinkOptions = {},
): void {
  let prevPath: string | undefined;
  for (const payload of payloads) {
    if (payload.meta == null) payload.meta = {};
    const meta = payload.meta as Record<string, unknown>;
    meta[META_THREAD] = threadId;
    if (prevPath !== undefined) meta[META_PREV] = prevPath;
    // The next message's `$prev` is this message's path. A named payload always
    // has a name here (messageName); guard so a nameless row just breaks the
    // chain rather than emitting a malformed path.
    prevPath =
      payload.name != null
        ? linkedMemoryPath(payload.tree, payload.name, opts)
        : undefined;
  }
}

/** One git-commit payload plus its first-parent sha, for `stampGitPrevLinks`. */
export interface GitLinkEntry {
  payload: MemoryCreateParams;
  /** `commit.parents[0]`, or undefined for a root commit. */
  firstParent: string | undefined;
}

/**
 * Stamp `$prev` on git-commit payloads: each commit links back to its
 * first-parent commit's path. Merges dropped as boilerplate are stepped
 * *through* (via `skipped`, mapping a dropped sha → its own first parent) so a
 * kept commit links to the nearest imported ancestor rather than a dropped
 * merge. Git stores neither `$thread` nor `$next` — the UI derives `$next`.
 *
 * Pass `inSet` (the shas in this batch) for a full/bounded walk: `$prev` is then
 * set only when the resolved parent is in the batch, so the oldest commit of a
 * bounded import doesn't dangle. Omit `inSet` for an incremental walk, where the
 * resolved parent (the high-water commit and its ancestors) is already imported
 * though not present in this batch.
 */
export function stampGitPrevLinks(
  entries: GitLinkEntry[],
  opts: { skipped: Map<string, string>; inSet?: Set<string> },
): void {
  for (const { payload, firstParent } of entries) {
    let parent = firstParent;
    const seen = new Set<string>();
    // Follow dropped (boilerplate) merges to the nearest recorded ancestor;
    // `seen` guards against a pathological cycle in the skipped map.
    while (
      parent !== undefined &&
      opts.skipped.has(parent) &&
      !seen.has(parent)
    ) {
      seen.add(parent);
      parent = opts.skipped.get(parent);
    }
    if (parent === undefined) continue; // root commit — no previous
    if (opts.inSet !== undefined && !opts.inSet.has(parent)) continue; // below the floor
    if (payload.meta == null) payload.meta = {};
    const meta = payload.meta as Record<string, unknown>;
    meta[META_PREV] = memoryPath(payload.tree, parent);
  }
}
