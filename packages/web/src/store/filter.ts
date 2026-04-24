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
import type { MemorySearchParams, TemporalFilter } from "@memory.build/client";
import { create } from "zustand";

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

/**
 * Human-readable summary of the active filter, used by the collapsed
 * search bar.
 *
 * Returns a list of short chip labels ("semantic: …", "tree: work.*", …)
 * and a boolean indicating whether any filter is applied. An empty list +
 * `hasFilter: false` means the user has nothing active and the RPC will
 * fall back to list-all (via `normalizeSearchParams`).
 */
export function summarizeFilter(state: FilterState): {
  chips: string[];
  hasFilter: boolean;
} {
  if (state.mode === "simple") {
    const q = state.simple.trim();
    if (!q) return { chips: [], hasFilter: false };
    return { chips: [`query: "${truncate(q, 60)}"`], hasFilter: true };
  }

  const a = state.advanced;
  const chips: string[] = [];

  if (a.semantic.trim()) {
    chips.push(`semantic: "${truncate(a.semantic.trim(), 40)}"`);
  }
  if (a.fulltext.trim()) {
    chips.push(`fulltext: "${truncate(a.fulltext.trim(), 40)}"`);
  }
  if (a.grep.trim()) chips.push(`grep: /${truncate(a.grep.trim(), 30)}/`);
  if (a.tree.trim()) chips.push(`tree: ${truncate(a.tree.trim(), 40)}`);

  const metaChip = summarizeMetaJson(a.metaJson);
  if (metaChip) chips.push(metaChip);

  const temporalChip = summarizeTemporal(a.temporal);
  if (temporalChip) chips.push(temporalChip);

  if (a.limit.trim()) chips.push(`limit: ${a.limit.trim()}`);
  if (a.candidateLimit.trim()) {
    chips.push(`candidateLimit: ${a.candidateLimit.trim()}`);
  }

  const ws = a.weightsSemantic.trim();
  const wf = a.weightsFulltext.trim();
  if (ws || wf) {
    const parts: string[] = [];
    if (ws) parts.push(`sem=${ws}`);
    if (wf) parts.push(`full=${wf}`);
    chips.push(`weights: ${parts.join(", ")}`);
  }

  if (a.orderBy) chips.push(`order: ${a.orderBy}`);

  return { chips, hasFilter: chips.length > 0 };
}

function summarizeMetaJson(raw: string): string | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "meta: (not an object)";
    }
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length === 0) return "meta: {}";
    return `meta: {${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  } catch {
    return "meta: (invalid JSON)";
  }
}

function summarizeTemporal(t: AdvancedFilter["temporal"]): string | null {
  if (t.mode === "contains") {
    return t.start ? `temporal contains ${t.start}` : null;
  }
  if (!t.start || !t.end) return null;
  return `temporal ${t.mode} [${t.start} → ${t.end}]`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
