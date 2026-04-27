import type { MemoryWithScoreResponse } from "@memory.build/client";
import { useEffect, useRef } from "react";
import { formatScore } from "../lib/search-results.ts";
import { useMemorySelection } from "../lib/useMemorySelection.ts";
import { useUi } from "../store/ui.ts";

export function SearchResultRow({
  fragment,
  memory,
}: {
  fragment: string;
  memory: MemoryWithScoreResponse;
}) {
  const { selected, selectMemory } = useMemorySelection(memory.id);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!selected) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { kind: "memory", id: memory.id, title: fragment },
    });
  };

  return (
    <li ref={rowRef} aria-current={selected ? "true" : undefined}>
      <button
        type="button"
        onClick={selectMemory}
        onContextMenu={handleContextMenu}
        className={[
          "block w-full cursor-pointer px-3 py-2 text-left text-sm",
          selected
            ? "bg-sky-100 text-sky-950"
            : "text-slate-700 hover:bg-slate-100",
        ].join(" ")}
      >
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500">
          <span
            className="min-w-0 truncate font-mono flex-auto"
            title={memory.tree || "(root)"}
          >
            {memory.tree || "(root)"}
          </span>
          <span className="shrink-0 rounded bg-white/70 px-1.5 py-0.5 font-mono text-slate-600 ring-1 ring-slate-200">
            {formatScore(memory.score)}
          </span>
        </div>
        <div className="line-clamp-2 text-sm leading-snug">{fragment}</div>
      </button>
    </li>
  );
}
