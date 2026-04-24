/**
 * Tree view — dual-mode renderer.
 *
 * Browse mode (no active search filter):
 *   - Fetches the full path hierarchy from `memory.tree` (no limit, no
 *     content) so every path is always visible.
 *   - Leaves load lazily per expanded path; a single always-on query
 *     surfaces empty-tree memories under the synthetic `.` bucket.
 *
 * Search mode (filter has at least one criterion):
 *   - Runs `memory.search` with the normalized filter and builds a tree
 *     from the matching memories. Leaves render inline (no lazy fetch)
 *     and paths are force-expanded so every match is visible without
 *     hunting.
 *   - The 1000-row search cap is acceptable here because it applies to
 *     matches, not to the universe of memories.
 */
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import {
  useMemories,
  useMemoriesAtExactPath,
  useTree,
} from "../../api/queries.ts";
import {
  buildPathTree,
  buildSearchTree,
  collectPaths,
} from "../../lib/tree-build.ts";
import { useDebounced } from "../../lib/useDebounced.ts";
import { selectSearchParams, useFilter } from "../../store/filter.ts";
import { useSelection } from "../../store/selection.ts";
import { PathRow } from "./TreeNodeRow.tsx";

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

  const searchRoots = useMemo(
    () => buildSearchTree(search.data?.results ?? []),
    [search.data?.results],
  );

  const roots = searchActive ? searchRoots : browseRoots;

  const pruneExpanded = useSelection((s) => s.pruneExpanded);
  useEffect(() => {
    pruneExpanded(collectPaths(roots));
  }, [roots, pruneExpanded]);

  const activeError = searchActive ? search.error : tree.error;
  const activeLoading = searchActive ? search.isLoading : tree.isLoading;

  if (activeError) {
    return (
      <div className="p-4 text-sm text-red-700">
        <p className="font-medium">
          {searchActive ? "Search failed" : "Failed to load tree"}
        </p>
        <p className="mt-1 text-xs text-red-600">
          {activeError instanceof Error
            ? activeError.message
            : String(activeError)}
        </p>
      </div>
    );
  }

  if (activeLoading) {
    return (
      <div className="p-4 text-sm text-slate-500">
        {searchActive ? "Searching…" : "Loading tree…"}
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="p-4 text-sm text-slate-500">
        {searchActive
          ? "No memories match the current filter."
          : "No memories yet. Create one from the CLI or MCP server to see it here."}
      </div>
    );
  }

  return (
    <div className="py-1" role="tree" aria-label="Memories">
      {roots.map((node) => (
        <PathRow key={node.path} node={node} forceOpen={searchActive} />
      ))}
    </div>
  );
}
