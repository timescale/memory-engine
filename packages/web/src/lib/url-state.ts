/**
 * URL ↔ filter + selection state sync.
 *
 * On page load, read the URL search params into the stores. On every
 * subsequent state change, push the state back to the URL with
 * `replaceState` so the address bar reflects the current view without
 * polluting browser history on every keystroke.
 *
 * Intentionally compact — all UI state can round-trip through these
 * functions, so shareable URLs just work.
 */
import {
  type AdvancedFilter,
  EMPTY_ADVANCED,
  type FilterMode,
  type FilterState,
  type TemporalMode,
} from "../store/filter.ts";

/**
 * Encode the UI state into URL search params.
 */
export function encodeUrlState(
  filter: FilterState,
  selectedId: string | null,
): string {
  const p = new URLSearchParams();

  if (filter.mode === "advanced") p.set("mode", "advanced");

  if (filter.mode === "simple") {
    if (filter.simple) p.set("q", filter.simple);
  } else {
    const a = filter.advanced;
    if (a.semantic) p.set("semantic", a.semantic);
    if (a.fulltext) p.set("fulltext", a.fulltext);
    if (a.grep) p.set("grep", a.grep);
    if (a.tree) p.set("tree", a.tree);
    if (a.metaJson) p.set("meta", a.metaJson);
    if (a.temporal.mode !== "overlaps") p.set("temporal_mode", a.temporal.mode);
    if (a.temporal.start) p.set("temporal_start", a.temporal.start);
    if (a.temporal.end) p.set("temporal_end", a.temporal.end);
    if (a.limit) p.set("limit", a.limit);
    if (a.candidateLimit) p.set("candidate_limit", a.candidateLimit);
    if (a.semanticThreshold) p.set("semantic_threshold", a.semanticThreshold);
    if (a.weightsSemantic) p.set("weights_semantic", a.weightsSemantic);
    if (a.weightsFulltext) p.set("weights_fulltext", a.weightsFulltext);
    if (a.orderBy) p.set("order_by", a.orderBy);
  }

  if (selectedId) p.set("selected", selectedId);

  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Decode URL search params into the UI state. Unknown keys are ignored.
 */
export function decodeUrlState(search: string): {
  filter: FilterState;
  selectedId: string | null;
} {
  const p = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );

  const mode: FilterMode = p.get("mode") === "advanced" ? "advanced" : "simple";

  const advanced: AdvancedFilter = {
    ...EMPTY_ADVANCED,
    semantic: p.get("semantic") ?? "",
    fulltext: p.get("fulltext") ?? "",
    grep: p.get("grep") ?? "",
    tree: p.get("tree") ?? "",
    metaJson: p.get("meta") ?? "",
    temporal: {
      mode: (p.get("temporal_mode") as TemporalMode | null) ?? "overlaps",
      start: p.get("temporal_start") ?? "",
      end: p.get("temporal_end") ?? "",
    },
    limit: p.get("limit") ?? "",
    candidateLimit: p.get("candidate_limit") ?? "",
    semanticThreshold: p.get("semantic_threshold") ?? "",
    weightsSemantic: p.get("weights_semantic") ?? "",
    weightsFulltext: p.get("weights_fulltext") ?? "",
    orderBy: coerceOrderBy(p.get("order_by")),
  };

  return {
    filter: {
      mode,
      simple: p.get("q") ?? "",
      advanced,
    },
    selectedId: p.get("selected"),
  };
}

function coerceOrderBy(value: string | null): AdvancedFilter["orderBy"] {
  return value === "asc" || value === "desc" ? value : "";
}

/**
 * Replace the current URL with the encoded state. Safe to call on every
 * keystroke because it uses `replaceState` (no history entry per change).
 */
export function replaceUrlState(
  filter: FilterState,
  selectedId: string | null,
): void {
  if (typeof window === "undefined") return;
  const qs = encodeUrlState(filter, selectedId);
  const next = `${window.location.pathname}${qs}${window.location.hash}`;
  if (
    next !==
    `${window.location.pathname}${window.location.search}${window.location.hash}`
  ) {
    window.history.replaceState(null, "", next);
  }
}
