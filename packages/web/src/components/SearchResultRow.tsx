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
      target: { kind: "memory", id: memory.id, title: memory.name ?? fragment },
    });
  };

  return (
    <li ref={rowRef} aria-current={selected ? "true" : undefined}>
      <button
        type="button"
        onClick={selectMemory}
        onContextMenu={handleContextMenu}
        className={[
          "block w-full cursor-pointer px-3 py-2 text-left text-[13px] transition-colors",
          selected
            ? "bg-ink/[0.08] text-ink"
            : "text-ink/70 hover:bg-ink/[0.04]",
        ].join(" ")}
      >
        <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[11px] text-ink/50">
          <span
            className="min-w-0 flex-auto truncate"
            title={memory.tree || "(root)"}
          >
            {memory.tree || "(root)"}
          </span>
          {memory.name && (
            <span
              className="min-w-0 shrink truncate font-medium text-ink/80"
              title={memory.name}
            >
              {memory.name}
            </span>
          )}
          <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-ink/70 ring-1 ring-ink/[0.12]">
            {formatScore(memory.score)}
          </span>
        </div>
        <div className="line-clamp-2 text-[13px] leading-snug">{fragment}</div>
      </button>
    </li>
  );
}
