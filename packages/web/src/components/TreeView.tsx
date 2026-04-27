/**
 * Tree view — dual-mode renderer.
 *
 * Browse mode (no active search filter): fetches the full path hierarchy
 * from `memory.tree` and lazy-loads leaves per expanded path.
 *
 * Search mode (filter has at least one criterion): runs `memory.search` and
 * builds a matching tree from the results. When a text filter is present,
 * the sidebar splits vertically and shows relevance-sorted flat results
 * above that matching tree.
 */
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/shallow";
import {
  useMemories,
  useMemoriesAtExactPath,
  useTree,
} from "../api/queries.ts";
import { hasTextFilter } from "../lib/search-results.ts";
import {
  buildPathTree,
  buildSearchTree,
  collectPaths,
} from "../lib/tree-build.ts";
import { useDebounced } from "../lib/useDebounced.ts";
import { selectSearchParams, useFilter } from "../store/filter.ts";
import { useSelection } from "../store/selection.ts";
import { SearchSplitPane } from "./SearchSplitPane.tsx";
import { TreeContent } from "./TreeContent.tsx";

export function TreeView() {
  const filterState = useFilter(
    useShallow((s) => ({
      mode: s.mode,
      simple: s.simple,
      advanced: s.advanced,
    })),
  );
  const debouncedFilter = useDebounced(filterState, 250);
  const searchParams = useMemo(
    () => selectSearchParams(debouncedFilter),
    [debouncedFilter],
  );
  const searchActive = Object.keys(searchParams).length > 0;
  const textFilterActive = hasTextFilter(debouncedFilter);

  // Browse-mode queries — fire only when search is inactive.
  const tree = useTree();
  const rootLeaves = useMemoriesAtExactPath("", !searchActive);

  // Search-mode query — fires only when search is active.
  const search = useMemories(searchParams, searchActive);

  const browseRoots = useMemo(() => {
    const treeNodes = tree.data?.nodes ?? [];
    const rootLeafCount = rootLeaves.data?.total ?? 0;
    return buildPathTree(treeNodes, rootLeafCount);
  }, [tree.data?.nodes, rootLeaves.data?.total]);

  const searchResults = search.data?.results ?? [];
  const searchRoots = useMemo(
    () => buildSearchTree(searchResults),
    [searchResults],
  );

  const roots = searchActive ? searchRoots : browseRoots;

  const context = searchActive ? "search" : "browse";
  const canPruneExpanded = searchActive
    ? search.data !== undefined
    : tree.data !== undefined && rootLeaves.data !== undefined;
  const pruneExpanded = useSelection((s) => s.pruneExpanded);
  useEffect(() => {
    if (!canPruneExpanded) return;
    pruneExpanded(context, collectPaths(roots));
  }, [canPruneExpanded, context, roots, pruneExpanded]);

  // One-time seeding: when the tree first loads, auto-expand every
  // top-level path so the user sees the hierarchy's shape without having
  // to click into each root. We gate on `browseSeededRef` so user
  // collapses aren't undone by subsequent tree refreshes.
  const setExpanded = useSelection((s) => s.setExpanded);
  const browseSeededRef = useRef(false);
  useEffect(() => {
    if (browseSeededRef.current) return;
    if (!tree.data) return;
    browseSeededRef.current = true;
    for (const node of tree.data.nodes) {
      if (!node.path.includes(".")) {
        setExpanded("browse", node.path, true);
      }
    }
  }, [tree.data, setExpanded]);

  const activeError = searchActive ? search.error : tree.error;
  const activeLoading = searchActive ? search.isLoading : tree.isLoading;
  const treeContent = (
    <TreeContent
      activeError={activeError}
      activeLoading={activeLoading}
      context={context}
      roots={roots}
      searchActive={searchActive}
    />
  );

  if (!textFilterActive) {
    return <div className="h-full overflow-auto">{treeContent}</div>;
  }

  return (
    <SearchSplitPane
      results={searchResults}
      loading={search.isLoading}
      error={search.error}
      filter={debouncedFilter}
    >
      {treeContent}
    </SearchSplitPane>
  );
}
