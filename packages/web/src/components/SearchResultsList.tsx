import type { MemoryWithScoreResponse } from "@memory.build/client";
import { useMemo } from "react";
import {
  buildTextMatchers,
  compareResultsByRelevance,
  contentFragment,
} from "../lib/search-results.ts";
import type { FilterState } from "../store/filter.ts";
import { SearchResultRow } from "./SearchResultRow.tsx";

export function SearchResultsList({
  error,
  filter,
  loading,
  results,
}: {
  error: unknown;
  filter: FilterState;
  loading: boolean;
  results: MemoryWithScoreResponse[];
}) {
  const textMatchers = useMemo(() => buildTextMatchers(filter), [filter]);
  const sortedResults = useMemo(
    () => [...results].sort(compareResultsByRelevance),
    [results],
  );

  return (
    <div className="min-h-full">
      <div className="sticky top-0 z-10 border-b border-ink/[0.1] bg-white/90 px-3 py-2 backdrop-blur">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink/50">
            search results
          </h2>
          {!loading && !error && (
            <span className="font-mono text-[11px] text-ink/40">
              {sortedResults.length}{" "}
              {sortedResults.length === 1 ? "match" : "matches"}
            </span>
          )}
        </div>
      </div>

      {error ? (
        <div className="p-3 text-[13px] text-tiger-red">
          <p className="font-medium">Search results failed</p>
          <p className="mt-1 font-mono text-[11px] text-tiger-red/80">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      ) : loading ? (
        <div className="p-3 text-[13px] text-ink/50">Searching…</div>
      ) : sortedResults.length === 0 ? (
        <div className="p-3 text-[13px] text-ink/50">
          No memories match the current text filter.
        </div>
      ) : (
        <ol className="divide-y divide-ink/[0.08]">
          {sortedResults.map((memory) => (
            <SearchResultRow
              key={memory.id}
              memory={memory}
              fragment={contentFragment(memory.content, textMatchers)}
              matchers={textMatchers}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
