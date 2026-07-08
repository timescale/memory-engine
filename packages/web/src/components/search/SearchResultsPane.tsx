/**
 * The search-results column — the middle pane while a text filter is active.
 *
 * Owns two arrival behaviors, both keyed off the (debounced) active search:
 *   - scroll back to the top whenever the filter changes (including the
 *     pane's first appearance), so a new query always starts at the best
 *     match rather than a stale scroll offset;
 *   - auto-select the top result so the preview pane immediately reflects
 *     the search (see `autoSelectTarget` for the cases that are left alone:
 *     a selection that is itself a match, a shared-link selection, a dirty
 *     editor).
 *
 * Reads the selection/editor stores via `getState()` inside the effect so
 * auto-select decisions happen only when a result set arrives — not when
 * the selection changes.
 */
import { useEffect, useRef } from "react";
import { autoSelectTarget } from "../../lib/search-results.ts";
import { useActiveSearch } from "../../lib/useActiveSearch.ts";
import { useEditor } from "../../store/editor.ts";
import { useLayout } from "../../store/layout.ts";
import { useSelection } from "../../store/selection.ts";
import { SearchResultsList } from "../SearchResultsList.tsx";

export function SearchResultsPane() {
  const { filter, search } = useActiveSearch();
  const width = useLayout((s) => s.searchColumnWidth);
  const sectionRef = useRef<HTMLElement>(null);
  const results = search.data?.results;

  // biome-ignore lint/correctness/useExhaustiveDependencies(filter): `filter` is the trigger, not an input — a query change resets the scroll position.
  useEffect(() => {
    sectionRef.current?.scrollTo({ top: 0 });
  }, [filter]);

  // The (debounced) filter whose result arrival was last handled — a new
  // filter forces re-selecting the top result, a same-filter refetch keeps
  // the user's place. Identity comparison is enough: the store hands out a
  // new object only on an actual change.
  const handledFilterRef = useRef<typeof filter | null>(null);
  useEffect(() => {
    if (!results) return;
    const filterChanged = handledFilterRef.current !== filter;
    handledFilterRef.current = filter;
    const { selectedId, selectedVia } = useSelection.getState();
    const target = autoSelectTarget({
      results,
      selectedId,
      selectedVia,
      editorDirty: useEditor.getState().dirty,
      filterChanged,
    });
    if (target !== null) useSelection.getState().select(target);
  }, [results, filter]);

  return (
    <section
      ref={sectionRef}
      className="min-h-0 shrink-0 overflow-auto border-r border-ink/[0.12] bg-ink/[0.02]"
      style={{ width }}
      aria-label="Relevance-sorted search results"
    >
      <SearchResultsList
        error={search.error}
        filter={filter}
        loading={search.isLoading}
        results={results ?? []}
      />
    </section>
  );
}
