import type { MemoryWithScoreResponse } from "@memory.build/client";
import { useRef } from "react";
import {
  MIN_SEARCH_RESULTS_HEIGHT,
  MIN_TREE_PANE_HEIGHT,
  SEARCH_RESULTS_RESIZER_HEIGHT,
} from "../lib/split-pane.ts";
import type { FilterState } from "../store/filter.ts";
import { useLayout } from "../store/layout.ts";
import { SearchResultsList } from "./SearchResultsList.tsx";
import { SearchResultsResizer } from "./SearchResultsResizer.tsx";

export function SearchSplitPane({
  children,
  error,
  filter,
  loading,
  results,
}: {
  children: React.ReactNode;
  error: unknown;
  filter: FilterState;
  loading: boolean;
  results: MemoryWithScoreResponse[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchResultsHeight = useLayout((s) => s.searchResultsHeight);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <section
        className="min-h-0 shrink-0 overflow-auto border-b border-slate-200 bg-slate-50"
        style={{
          height: searchResultsHeight,
          minHeight: MIN_SEARCH_RESULTS_HEIGHT,
          maxHeight: `calc(100% - ${MIN_TREE_PANE_HEIGHT + SEARCH_RESULTS_RESIZER_HEIGHT}px)`,
        }}
        aria-label="Relevance-sorted search results"
      >
        <SearchResultsList
          error={error}
          filter={filter}
          loading={loading}
          results={results}
        />
      </section>
      <SearchResultsResizer containerRef={containerRef} />
      <section
        className="min-h-0 flex-1 overflow-auto bg-white"
        style={{ minHeight: MIN_TREE_PANE_HEIGHT }}
        aria-label="Tree"
      >
        {children}
      </section>
    </div>
  );
}
