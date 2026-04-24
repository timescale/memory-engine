/**
 * Recursive row renderers for the tree.
 *
 * `PathRow` handles one path-hierarchy node: its own label + count, an
 * expand/collapse toggle, and \u2014 when expanded \u2014 nested sub-paths plus
 * memory leaves that live at exactly this path. Leaves are fetched lazily
 * via `useMemoriesAtExactPath` and only when the row is open; the query is
 * also gated by `directCount > 0` so we don't waste a round-trip on pure
 * container paths that have no direct memories.
 *
 * `MemoryRow` renders one fetched leaf: click to select, right-click for
 * the context menu.
 */
import { useMemo } from "react";
import { useMemoriesAtExactPath } from "../../api/queries.ts";
import {
  type MemoryLeaf,
  memoryToLeaf,
  type PathNode,
  ROOT_PATH,
  sortLeaves,
} from "../../lib/tree-build.ts";
import { confirmDiscardChangesIfDirty } from "../../store/editor.ts";
import {
  selectIsExpanded,
  type TreeContext,
  useSelection,
} from "../../store/selection.ts";
import { useUi } from "../../store/ui.ts";

const INDENT_PX = 16;

/**
 * Disclosure chevron. Rendered as an inline SVG so its geometry is
 * pixel-consistent across platforms (unicode triangles ▸/▾ render at
 * wildly different sizes and baselines depending on the system font).
 * The parent button uses `items-center`; the fixed 16×16 viewBox gives
 * us a predictable bounding box that centers cleanly with the label.
 */
function Caret({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-slate-400 transition-transform"
      style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
      fill="currentColor"
    >
      <path d="M6 4l5 4-5 4V4z" />
    </svg>
  );
}

/**
 * Leaf marker. Fixed 16×16 inline-flex box so the dot lands in the same
 * column as the caret above (and stays vertically centered regardless of
 * the text's line height).
 */
function LeafBullet() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-4 shrink-0 items-center justify-center text-slate-400"
    >
      <span className="block size-1 rounded-full bg-current" />
    </span>
  );
}

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

  const leaves = useMemo<MemoryLeaf[]>(() => {
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
        style={{ paddingLeft: `${8 + node.depth * INDENT_PX}px` }}
      >
        <Caret expanded={expanded} />
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
              style={{
                paddingLeft: `${8 + (node.depth + 1) * INDENT_PX}px`,
              }}
            >
              Loading memories…
            </div>
          )}

          {!hasInline && node.directCount > 0 && leavesQuery.error && (
            <div
              className="px-2 py-1 text-xs text-red-600"
              style={{
                paddingLeft: `${8 + (node.depth + 1) * INDENT_PX}px`,
              }}
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

function MemoryRow({ leaf }: { leaf: MemoryLeaf }) {
  const selected = useSelection((s) => s.selectedId === leaf.id);
  const select = useSelection((s) => s.select);
  const openContextMenu = useUi((s) => s.openContextMenu);

  const handleClick = () => {
    if (selected) return;
    if (!confirmDiscardChangesIfDirty()) return;
    select(leaf.id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    // Stop bubbling so the ancestor PathRow doesn't overwrite our target
    // with its "path" kind and swap the context-menu items.
    e.stopPropagation();
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      target: { kind: "memory", id: leaf.id, title: leaf.title },
    });
  };

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={handleClick}
        className={[
          "flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-sm",
          selected
            ? "bg-sky-100 text-sky-900"
            : "text-slate-700 hover:bg-slate-100",
        ].join(" ")}
        style={{ paddingLeft: `${8 + leaf.depth * INDENT_PX}px` }}
      >
        <LeafBullet />
        <span className="min-w-0 flex-1 truncate">{leaf.title}</span>
      </button>
    </div>
  );
}
