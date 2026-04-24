/**
 * Tree view — renders a nested `PathNode` into an accessible tree.
 *
 * Keeps expansion state + selection state in `useSelection`. Rendering is
 * delegated to the recursive `TreeNodeRow` component. Markup uses `<div>`
 * with ARIA `tree` / `treeitem` roles so Biome's a11y rules are satisfied
 * and focus + keyboard can be added later without restructuring.
 */
import { useEffect, useMemo } from "react";
import type { MemoryWithScore } from "../../api/types.ts";
import { buildTree, collectPaths } from "../../lib/tree-build.ts";
import { useSelection } from "../../store/selection.ts";
import { TreeNodeRow } from "./TreeNodeRow.tsx";

interface TreeViewProps {
  memories: MemoryWithScore[];
  isLoading: boolean;
  error: Error | null;
}

export function TreeView({ memories, isLoading, error }: TreeViewProps) {
  const roots = useMemo(() => buildTree(memories), [memories]);
  const pruneExpanded = useSelection((s) => s.pruneExpanded);

  useEffect(() => {
    pruneExpanded(collectPaths(roots));
  }, [roots, pruneExpanded]);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-700">
        <p className="font-medium">Failed to load memories</p>
        <p className="mt-1 text-xs text-red-600">{error.message}</p>
      </div>
    );
  }

  if (isLoading) {
    return <div className="p-4 text-sm text-slate-500">Loading memories…</div>;
  }

  if (roots.length === 0) {
    return (
      <div className="p-4 text-sm text-slate-500">
        No memories match the current filter.
      </div>
    );
  }

  return (
    <div className="py-1" role="tree" aria-label="Memories">
      {roots.map((node) => (
        <TreeNodeRow
          key={node.kind === "path" ? `p:${node.path}` : `m:${node.id}`}
          node={node}
        />
      ))}
    </div>
  );
}
