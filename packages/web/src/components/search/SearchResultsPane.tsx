/**
 * The search-results column — the middle pane while a search is active.
 *
 * Owns three behaviors, all keyed off the (debounced) active search:
 *   - scroll back to the top whenever the filter changes (including the
 *     pane's first appearance), so a new query always starts at the best
 *     match rather than a stale scroll offset;
 *   - collapse the preview pane on a filter change, so a new search starts
 *     as a full-width list — clicking a result reopens the preview. Skipped
 *     for a shared-link selection (`?selected=…` must show its memory,
 *     which also keeps a mid-search reload's view intact) and for a dirty
 *     editor (never unmount unsaved edits from a passive effect);
 *   - auto-select the top result so the selection tracks the search (see
 *     `autoSelectTarget` for the cases that are left alone).
 *
 * Reads the selection/editor stores via `getState()` inside the effects so
 * these decisions happen only on filter/result changes — not when the
 * selection changes.
 */
import { useEffect, useRef } from "react";
import { autoSelectTarget, displayResults } from "../../lib/search-results.ts";
import { useActiveSearch } from "../../lib/useActiveSearch.ts";
import { useEditor } from "../../store/editor.ts";
import { useLayout } from "../../store/layout.ts";
import { useSelection } from "../../store/selection.ts";
import { SearchResultsList } from "../SearchResultsList.tsx";

export function SearchResultsPane() {
  const { filter, search } = useActiveSearch();
  const width = useLayout((s) => s.searchColumnWidth);
  const previewCollapsed = useLayout((s) => s.searchPreviewCollapsed);
  const sectionRef = useRef<HTMLElement>(null);
  const results = search.data?.results;

  // biome-ignore lint/correctness/useExhaustiveDependencies(filter): `filter` is the trigger, not an input — a query change resets the scroll position and collapses the preview.
  useEffect(() => {
    sectionRef.current?.scrollTo({ top: 0 });
    const { selectedId, selectedVia } = useSelection.getState();
    const linkProtected = selectedId !== null && selectedVia === "link";
    if (!linkProtected && !useEditor.getState().dirty) {
      useLayout.getState().setSearchPreviewCollapsed(true);
    }
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
      results: displayResults(results, filter),
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
      className={
        previewCollapsed
          ? "min-h-0 min-w-0 flex-1 overflow-auto bg-ink/[0.02]"
          : "min-h-0 shrink-0 overflow-auto border-r border-ink/[0.12] bg-ink/[0.02]"
      }
      style={previewCollapsed ? undefined : { width }}
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
