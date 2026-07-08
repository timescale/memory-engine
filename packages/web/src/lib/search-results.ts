import type { FilterState } from "../store/filter.ts";

const RESULT_FRAGMENT_MAX_CHARS = 180;

export interface TextMatchers {
  terms: string[];
  regex: RegExp | null;
}

export function hasTextFilter(state: FilterState): boolean {
  if (state.mode === "simple") return state.simple.trim().length > 0;
  return (
    state.advanced.semantic.trim().length > 0 ||
    state.advanced.fulltext.trim().length > 0 ||
    state.advanced.grep.trim().length > 0
  );
}

export function compareResultsByRelevance(
  a: { score: number; createdAt: string },
  b: { score: number; createdAt: string },
): number {
  const scoreCmp = b.score - a.score;
  if (scoreCmp !== 0) return scoreCmp;
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * True when the server's result order is the meaningful one and must not
 * be re-sorted by relevance: an explicit `orderBy` with no text criterion.
 * The engine only honors `orderBy` in the no-ranking arm (ordered by
 * uuidv7 id, i.e. chronologically — importers seed message-time ids), so
 * with a text criterion relevance ordering still applies.
 */
export function preservesServerOrder(filter: FilterState): boolean {
  return (
    filter.mode === "advanced" &&
    filter.advanced.orderBy !== "" &&
    !hasTextFilter(filter)
  );
}

/**
 * The results in display order: the server's order when it carries the
 * meaning (see {@link preservesServerOrder}), relevance order otherwise.
 */
export function displayResults<T extends { score: number; createdAt: string }>(
  results: T[],
  filter: FilterState,
): T[] {
  if (preservesServerOrder(filter)) return [...results];
  return [...results].sort(compareResultsByRelevance);
}

/**
 * Decide which memory (if any) the search-results pane should auto-select
 * when a result set arrives, so the preview pane reflects the search
 * instead of sitting idle. Returns the id to select, or null to leave the
 * selection alone.
 *
 * Selects the top result — `results` must already be in display order
 * (see {@link displayResults}), so "top" is the first entry. A changed
 * query (`filterChanged`) always re-selects — "is the old selection among
 * the results" is no signal to keep it, because semantic search matches
 * nearly everything — while a refetch of the same query keeps a
 * still-matching selection (the user's place). Two guards always win:
 *   - a selection from a shared link (`selectedVia === "link"`) — a
 *     `?selected=…` URL may deliberately pair a memory with a filter it
 *     doesn't match. The protection lasts until the user edits the filter
 *     (the filter store demotes the selection to "user");
 *   - unsaved editor changes (never discard them from a passive effect).
 */
export function autoSelectTarget(args: {
  /** Result set in display order — the first entry is the top result. */
  results: { id: string }[];
  selectedId: string | null;
  selectedVia: "user" | "link";
  editorDirty: boolean;
  /** True when the result set belongs to a different query than the last one handled. */
  filterChanged: boolean;
}): string | null {
  const { results, selectedId, selectedVia, editorDirty, filterChanged } = args;
  const [top] = results;
  if (!top) return null;
  if (selectedId !== null && selectedVia === "link") return null;
  if (editorDirty) return null;
  if (
    !filterChanged &&
    selectedId !== null &&
    results.some((r) => r.id === selectedId)
  ) {
    return null;
  }
  return top.id === selectedId ? null : top.id;
}

export function buildTextMatchers(filter: FilterState): TextMatchers {
  const text =
    filter.mode === "simple"
      ? filter.simple
      : [filter.advanced.semantic, filter.advanced.fulltext].join(" ");
  const terms = Array.from(
    new Set(
      text
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]{2,}/gu)
        ?.slice(0, 12) ?? [],
    ),
  );

  let regex: RegExp | null = null;
  if (filter.mode === "advanced" && filter.advanced.grep.trim()) {
    try {
      regex = new RegExp(filter.advanced.grep.trim(), "i");
    } catch {
      regex = null;
    }
  }

  return { terms, regex };
}

export function contentFragment(
  content: string,
  matchers: TextMatchers,
): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty memory)";

  const matchIndex = firstMatchIndex(compact, matchers);
  if (matchIndex === -1) {
    return truncateFragment(compact, RESULT_FRAGMENT_MAX_CHARS);
  }

  const halfWindow = Math.floor(RESULT_FRAGMENT_MAX_CHARS / 2);
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(compact.length, start + RESULT_FRAGMENT_MAX_CHARS);
  const adjustedStart = Math.max(0, end - RESULT_FRAGMENT_MAX_CHARS);
  return `${adjustedStart > 0 ? "…" : ""}${compact.slice(adjustedStart, end)}${end < compact.length ? "…" : ""}`;
}

export interface FragmentSegment {
  text: string;
  match: boolean;
}

/**
 * Split a fragment into alternating plain/matched segments so the view can
 * highlight the parts that matched the text filter. Term matches are
 * case-insensitive; a grep regex is applied globally. Overlapping or
 * adjacent match ranges are merged.
 */
export function fragmentSegments(
  fragment: string,
  matchers: TextMatchers,
): FragmentSegment[] {
  const ranges: [number, number][] = [];

  const lower = fragment.toLowerCase();
  for (const term of matchers.terms) {
    let from = 0;
    for (
      let index = lower.indexOf(term, from);
      index !== -1;
      index = lower.indexOf(term, from)
    ) {
      ranges.push([index, index + term.length]);
      from = index + term.length;
    }
  }

  if (matchers.regex) {
    const global = new RegExp(matchers.regex.source, "gi");
    for (
      let match = global.exec(fragment);
      match !== null;
      match = global.exec(fragment)
    ) {
      // A zero-width match would loop forever at the same lastIndex.
      if (match[0].length === 0) {
        global.lastIndex += 1;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  if (ranges.length === 0) return [{ text: fragment, match: false }];

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }

  const segments: FragmentSegment[] = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos)
      segments.push({ text: fragment.slice(pos, start), match: false });
    segments.push({ text: fragment.slice(start, end), match: true });
    pos = end;
  }
  if (pos < fragment.length) {
    segments.push({ text: fragment.slice(pos), match: false });
  }
  return segments;
}

export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "0";
  if (score === 0) return "0";
  if (Math.abs(score) >= 100) return score.toFixed(0);
  if (Math.abs(score) >= 1) return score.toFixed(3);
  if (Math.abs(score) >= 0.001) return score.toFixed(4);
  return score.toExponential(2);
}

function firstMatchIndex(text: string, matchers: TextMatchers): number {
  if (matchers.regex) {
    const match = matchers.regex.exec(text);
    if (match?.index !== undefined) return match.index;
  }

  const lower = text.toLowerCase();
  let best = -1;
  for (const term of matchers.terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}

function truncateFragment(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
