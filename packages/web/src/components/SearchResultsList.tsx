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
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 px-3 py-2 backdrop-blur">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Search results
          </h2>
          {!loading && !error && (
            <span className="text-xs text-slate-400">
              {sortedResults.length}{" "}
              {sortedResults.length === 1 ? "match" : "matches"}
            </span>
          )}
        </div>
      </div>

      {error ? (
        <div className="p-3 text-sm text-red-700">
          <p className="font-medium">Search results failed</p>
          <p className="mt-1 text-xs text-red-600">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      ) : loading ? (
        <div className="p-3 text-sm text-slate-500">Searching…</div>
      ) : sortedResults.length === 0 ? (
        <div className="p-3 text-sm text-slate-500">
          No memories match the current text filter.
        </div>
      ) : (
        <ol className="divide-y divide-slate-200">
          {sortedResults.map((memory) => (
            <SearchResultRow
              key={memory.id}
              memory={memory}
              fragment={contentFragment(memory.content, textMatchers)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
