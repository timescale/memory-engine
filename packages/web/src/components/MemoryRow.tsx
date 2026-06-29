import { useEffect, useRef } from "react";
import type { MemoryLeaf } from "../lib/tree-build.ts";
import { leafRowPaddingLeft } from "../lib/tree-layout.ts";
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
          "flex w-full items-center gap-[9px] rounded-md pr-2.5 text-left font-mono text-[12px] transition-colors duration-150",
          selected
            ? "bg-ink/[0.08] py-1.5 font-medium text-ink"
            : "py-[5px] text-ink/60 hover:bg-ink/[0.04]",
        ].join(" ")}
        style={{ paddingLeft: leafRowPaddingLeft(leaf.depth) }}
      >
        <MemoryLeafBullet selected={selected} />
        <span className="min-w-0 flex-1 truncate">{leaf.title}</span>
      </button>
    </div>
  );
}
