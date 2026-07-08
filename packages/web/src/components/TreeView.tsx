/**
 * Tree view — dual-mode renderer.
 *
 * Browse mode (no active search filter): fetches the full path hierarchy
 * from `memory.tree` and lazy-loads leaves per expanded path.
 *
 * Search mode (filter has at least one criterion): runs `memory.search`
 * (shared with the main-pane results column via `useActiveSearch`) and
 * builds a matching tree from the results.
 */
import { useEffect, useMemo, useRef } from "react";
import { useMemoriesAtExactPath, useTree } from "../api/queries.ts";
import {
  buildPathTree,
  buildSearchTree,
  collectPaths,
} from "../lib/tree-build.ts";
import { useActiveSearch } from "../lib/useActiveSearch.ts";
import { useSelection } from "../store/selection.ts";
import { TreeContent } from "./TreeContent.tsx";

export function TreeView() {
  const { search, searchActive } = useActiveSearch();

  // Browse-mode queries — fire only when search is inactive.
  const tree = useTree();
  const rootLeaves = useMemoriesAtExactPath("", !searchActive);

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
  return (
    <div className="h-full overflow-auto">
      <TreeContent
        activeError={activeError}
        activeLoading={activeLoading}
        context={context}
        roots={roots}
        searchActive={searchActive}
      />
    </div>
  );
}
