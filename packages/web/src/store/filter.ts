/**
 * Filter state — drives `useMemories` and syncs to/from the URL.
 *
 * The store holds two parallel representations:
 *
 *   - `simple` — a single query string used by the simple search bar.
 *   - `advanced` — individual fields for each `memory.search` parameter.
 *
 * The active mode decides which representation is used to build the RPC
 * params. Flipping modes doesn't discard the other side's state so the user
 * can bounce back and forth without retyping.
 *
 * Advanced-mode UI is wired in step 9 of plans/serve.md; step 8 only uses
 * simple mode. Keeping the full shape here avoids refactoring later.
 */
import { create } from "zustand";
import type { MemorySearchParams, TemporalFilter } from "../api/types.ts";

export type FilterMode = "simple" | "advanced";

export type TemporalMode = "contains" | "overlaps" | "within";

export interface AdvancedFilter {
  semantic: string;
  fulltext: string;
  grep: string;
  tree: string;
  /** Stored as a raw JSON string so the textarea edits are preserved. */
  metaJson: string;
  temporal: {
    mode: TemporalMode;
    /** ISO timestamp. Empty string = unset. */
    start: string;
    end: string;
  };
  /** Empty string means "use default (1000)". */
  limit: string;
  candidateLimit: string;
  weightsSemantic: string;
  weightsFulltext: string;
  orderBy: "" | "asc" | "desc";
}

export interface FilterState {
  mode: FilterMode;
  simple: string;
  advanced: AdvancedFilter;
}

interface FilterActions {
  setMode(mode: FilterMode): void;
  setSimple(value: string): void;
  setAdvanced(patch: Partial<AdvancedFilter>): void;
  clear(): void;
  /** Replace the whole state (used by URL hydration). */
  hydrate(state: FilterState): void;
}

export const EMPTY_ADVANCED: AdvancedFilter = {
  semantic: "",
  fulltext: "",
  grep: "",
  tree: "",
  metaJson: "",
  temporal: { mode: "overlaps", start: "", end: "" },
  limit: "",
  candidateLimit: "",
  weightsSemantic: "",
  weightsFulltext: "",
  orderBy: "",
};

export const EMPTY_FILTER: FilterState = {
  mode: "simple",
  simple: "",
  advanced: EMPTY_ADVANCED,
};

export const useFilter = create<FilterState & FilterActions>((set) => ({
  ...EMPTY_FILTER,

  setMode(mode) {
    set({ mode });
  },

  setSimple(value) {
    set({ simple: value });
  },

  setAdvanced(patch) {
    set((state) => ({ advanced: { ...state.advanced, ...patch } }));
  },

  clear() {
    set(EMPTY_FILTER);
  },

  hydrate(state) {
    set(state);
  },
}));

/**
 * Project the filter state into `memory.search` RPC params.
 *
 * `normalizeSearchParams` in queries.ts handles the final `tree: "*"`
 * fallback when everything is empty, so we don't need to repeat it here.
 */
export function selectSearchParams(state: FilterState): MemorySearchParams {
  if (state.mode === "simple") {
    const q = state.simple.trim();
    if (q.length === 0) return {};
    return { semantic: q, fulltext: q };
  }

  const a = state.advanced;
  const params: MemorySearchParams = {};
  if (a.semantic.trim()) params.semantic = a.semantic.trim();
  if (a.fulltext.trim()) params.fulltext = a.fulltext.trim();
  if (a.grep.trim()) params.grep = a.grep.trim();
  if (a.tree.trim()) params.tree = a.tree.trim();

  if (a.metaJson.trim()) {
    try {
      const parsed = JSON.parse(a.metaJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params.meta = parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON is reported in the UI; drop it from the RPC params.
    }
  }

  const temporal = buildTemporal(a.temporal);
  if (temporal) params.temporal = temporal;

  const limit = parseIntOrUndef(a.limit);
  if (limit !== undefined) params.limit = limit;

  const candidateLimit = parseIntOrUndef(a.candidateLimit);
  if (candidateLimit !== undefined) params.candidateLimit = candidateLimit;

  const ws = parseFloatOrUndef(a.weightsSemantic);
  const wf = parseFloatOrUndef(a.weightsFulltext);
  if (ws !== undefined || wf !== undefined) {
    params.weights = {};
    if (ws !== undefined) params.weights.semantic = ws;
    if (wf !== undefined) params.weights.fulltext = wf;
  }

  if (a.orderBy) params.orderBy = a.orderBy;

  return params;
}

function buildTemporal(
  t: AdvancedFilter["temporal"],
): TemporalFilter | undefined {
  if (t.mode === "contains") {
    if (!t.start) return undefined;
    return { contains: t.start };
  }
  if (!t.start || !t.end) return undefined;
  return t.mode === "overlaps"
    ? { overlaps: { start: t.start, end: t.end } }
    : { within: { start: t.start, end: t.end } };
}

function parseIntOrUndef(s: string): number | undefined {
  if (!s.trim()) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseFloatOrUndef(s: string): number | undefined {
  if (!s.trim()) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}
