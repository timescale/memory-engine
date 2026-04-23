/**
 * Recursive row renderer for the tree.
 *
 * Handles both `path` (expandable) and `memory` (leaf) nodes. Indentation
 * is computed from `node.depth` so the same component handles every level.
 * Uses `<div>` with ARIA `treeitem` role + `tabIndex={0}` to keep the a11y
 * linter happy and to make keyboard navigation trivial to add later.
 */
import type { PathNode, TreeNode } from "../../lib/tree-build.ts";
import { ROOT_PATH } from "../../lib/tree-build.ts";
import { confirmDiscardChangesIfDirty } from "../../store/editor.ts";
import { useSelection } from "../../store/selection.ts";
import { useUi } from "../../store/ui.ts";

interface Props {
  node: TreeNode;
}

const INDENT_PX = 16;

export function TreeNodeRow({ node }: Props) {
  if (node.kind === "path") return <PathRow node={node} />;
  return <MemoryRow node={node} />;
}

function PathRow({ node }: { node: PathNode }) {
  const expanded = useSelection((s) => s.expandedPaths.has(node.path));
  const toggle = useSelection((s) => s.toggleExpanded);
  const openContextMenu = useUi((s) => s.openContextMenu);

  // The synthetic root has no path to delete — skip its context menu.
  const handleContextMenu = (e: React.MouseEvent) => {
    if (node.path === ROOT_PATH) return;
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
        onClick={() => toggle(node.path)}
        className="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-left text-sm text-slate-700 hover:bg-slate-100"
        style={{ paddingLeft: `${8 + node.depth * INDENT_PX}px` }}
      >
        <span
          aria-hidden="true"
          className="inline-block w-4 text-slate-400 transition-transform"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▸
        </span>
        <span className="truncate font-medium">{node.label}</span>
      </button>
      {expanded &&
        node.children.length > 0 &&
        node.children.map((child) => (
          <TreeNodeRow
            key={child.kind === "path" ? `p:${child.path}` : `m:${child.id}`}
            node={child}
          />
        ))}
    </div>
  );
}

function MemoryRow({ node }: { node: Extract<TreeNode, { kind: "memory" }> }) {
  const selected = useSelection((s) => s.selectedId === node.id);
  const select = useSelection((s) => s.select);
  const openContextMenu = useUi((s) => s.openContextMenu);

  const handleClick = () => {
    if (selected) return;
    if (!confirmDiscardChangesIfDirty()) return;
    select(node.id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      target: { kind: "memory", id: node.id, title: node.title },
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
        style={{ paddingLeft: `${8 + node.depth * INDENT_PX}px` }}
      >
        <span aria-hidden="true" className="w-4 text-slate-400">
          •
        </span>
        <span className="truncate">{node.title}</span>
      </button>
    </div>
  );
}
