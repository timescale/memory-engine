import { useMemo } from "react";
import { useMemoriesAtExactPath } from "../api/queries.ts";
import {
  memoryToLeaf,
  type PathNode,
  ROOT_PATH,
  sortLeaves,
} from "../lib/tree-build.ts";
import { treeRowPaddingLeft } from "../lib/tree-layout.ts";
import {
  selectIsExpanded,
  type TreeContext,
  useSelection,
} from "../store/selection.ts";
import { useUi } from "../store/ui.ts";
import { DisclosureCaret } from "./DisclosureCaret.tsx";
import { MemoryRow } from "./MemoryRow.tsx";

export function PathRow({
  node,
  context,
}: {
  node: PathNode;
  /** Which expansion-state bucket this row reads/writes. */
  context: TreeContext;
}) {
  const expanded = useSelection((s) => selectIsExpanded(s, context, node.path));
  const toggle = useSelection((s) => s.toggleExpanded);
  const openContextMenu = useUi((s) => s.openContextMenu);

  // When the node already carries inline leaves (search mode), use them
  // directly. Otherwise lazy-fetch via RPC only when the path is open
  // AND has direct memories — empty containers (directCount === 0) skip
  // the round-trip.
  const hasInline = node.inlineLeaves !== undefined;
  const leavesQuery = useMemoriesAtExactPath(
    node.path,
    !hasInline && expanded && node.directCount > 0,
  );

  const leaves = useMemo(() => {
    if (hasInline) return node.inlineLeaves ?? [];
    if (!leavesQuery.data) return [];
    return sortLeaves(
      leavesQuery.data.results.map((m) => memoryToLeaf(m, node.depth + 1)),
    );
  }, [hasInline, node.inlineLeaves, leavesQuery.data, node.depth]);

  const handleContextMenu = (e: React.MouseEvent) => {
    // The synthetic `.` bucket isn't a real ltree path, so deleting it
    // via `memory.deleteTree` is meaningless — disable the context menu.
    if (node.path === ROOT_PATH) return;
    // Stop bubbling so an ancestor PathRow doesn't overwrite our target.
    e.stopPropagation();
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      target: { kind: "path", path: node.path },
    });
  };

  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      tabIndex={0}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={() => toggle(context, node.path)}
        className="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-left text-sm text-slate-700 hover:bg-slate-100"
        style={{ paddingLeft: treeRowPaddingLeft(node.depth) }}
      >
        <DisclosureCaret expanded={expanded} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {node.label}
        </span>
        <span className="shrink-0 pl-2 text-xs text-slate-400">
          {node.aggregateCount}
        </span>
      </button>

      {expanded && (
        <>
          {node.children.map((child) => (
            <PathRow key={child.path} node={child} context={context} />
          ))}

          {!hasInline && node.directCount > 0 && leavesQuery.isLoading && (
            <div
              className="px-2 py-1 text-xs text-slate-400"
              style={{ paddingLeft: treeRowPaddingLeft(node.depth + 1) }}
            >
              Loading memories…
            </div>
          )}

          {!hasInline && node.directCount > 0 && leavesQuery.error && (
            <div
              className="px-2 py-1 text-xs text-red-600"
              style={{ paddingLeft: treeRowPaddingLeft(node.depth + 1) }}
            >
              Failed to load:{" "}
              {leavesQuery.error instanceof Error
                ? leavesQuery.error.message
                : String(leavesQuery.error)}
            </div>
          )}

          {leaves.map((leaf) => (
            <MemoryRow key={leaf.id} leaf={leaf} />
          ))}
        </>
      )}
    </div>
  );
}
