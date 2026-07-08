/**
 * `useActiveSearch` — the active search, shared by every pane that renders it.
 *
 * Debounces the filter store, derives the RPC search params, and runs the
 * `memory.search` query (only when at least one criterion is set). Both the
 * sidebar tree (matching-tree mode) and the main-pane results column call
 * this hook; TanStack Query dedupes the fetch by key, so the search itself
 * runs once regardless of how many panes consume it.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useMemories } from "../api/queries.ts";
import { selectSearchParams, useFilter } from "../store/filter.ts";
import { hasTextFilter } from "./search-results.ts";
import { useDebounced } from "./useDebounced.ts";

export function useActiveSearch() {
  const filterState = useFilter(
    useShallow((s) => ({
      mode: s.mode,
      simple: s.simple,
      advanced: s.advanced,
    })),
  );
  const filter = useDebounced(filterState, 250);
  const searchParams = useMemo(() => selectSearchParams(filter), [filter]);
  /** Any criterion set — the tree renders in search (matching-tree) mode. */
  const searchActive = Object.keys(searchParams).length > 0;
  /** A text criterion set — relevance ordering exists, results pane shows. */
  const textFilterActive = hasTextFilter(filter);
  const search = useMemories(searchParams, searchActive);

  return { filter, searchActive, textFilterActive, search };
}
