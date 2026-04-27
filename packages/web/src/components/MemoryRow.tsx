import { useEffect, useRef } from "react";
import type { MemoryLeaf } from "../lib/tree-build.ts";
import { treeRowPaddingLeft } from "../lib/tree-layout.ts";
import { useMemorySelection } from "../lib/useMemorySelection.ts";
import { useUi } from "../store/ui.ts";
import { MemoryLeafBullet } from "./MemoryLeafBullet.tsx";

export function MemoryRow({ leaf }: { leaf: MemoryLeaf }) {
  const { selected, selectMemory } = useMemorySelection(leaf.id);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

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
      ref={rowRef}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={selectMemory}
        className={[
          "flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-sm",
          selected
            ? "bg-sky-100 text-sky-900"
            : "text-slate-700 hover:bg-slate-100",
        ].join(" ")}
        style={{ paddingLeft: treeRowPaddingLeft(leaf.depth) }}
      >
        <MemoryLeafBullet />
        <span className="min-w-0 flex-1 truncate">{leaf.title}</span>
      </button>
    </div>
  );
}
