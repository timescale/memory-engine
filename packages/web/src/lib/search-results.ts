import type { MemoryWithScoreResponse } from "@memory.build/client";
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
  a: MemoryWithScoreResponse,
  b: MemoryWithScoreResponse,
): number {
  const scoreCmp = b.score - a.score;
  if (scoreCmp !== 0) return scoreCmp;
  return b.createdAt.localeCompare(a.createdAt);
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
