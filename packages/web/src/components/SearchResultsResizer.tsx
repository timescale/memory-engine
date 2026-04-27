import { type RefObject, useCallback, useRef } from "react";
import {
  clampSearchResultsHeightToContainer,
  MIN_SEARCH_RESULTS_HEIGHT,
  maxSearchResultsHeightForContainer,
} from "../lib/split-pane.ts";
import { useLayout } from "../store/layout.ts";

const KEYBOARD_STEP_PX = 24;
const KEYBOARD_STEP_PX_LARGE = 96;

export function SearchResultsResizer({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const searchResultsHeight = useLayout((s) => s.searchResultsHeight);
  const setSearchResultsHeight = useLayout((s) => s.setSearchResultsHeight);
  const dragStartRef = useRef<{ clientY: number; height: number } | null>(null);
  const maxSearchResultsHeight = maxSearchResultsHeightForContainer(
    containerRef.current?.clientHeight,
  );

  const clampToContainer = useCallback(
    (height: number) =>
      clampSearchResultsHeightToContainer(
        height,
        containerRef.current?.clientHeight,
      ),
    [containerRef],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragStartRef.current = {
        clientY: event.clientY,
        height: searchResultsHeight,
      };

      const handleMove = (moveEvent: PointerEvent) => {
        const start = dragStartRef.current;
        if (!start) return;
        const nextHeight = start.height + (moveEvent.clientY - start.clientY);
        setSearchResultsHeight(clampToContainer(nextHeight));
      };

      const handleUp = () => {
        dragStartRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [clampToContainer, searchResultsHeight, setSearchResultsHeight],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEYBOARD_STEP_PX_LARGE : KEYBOARD_STEP_PX;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSearchResultsHeight(clampToContainer(searchResultsHeight - step));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSearchResultsHeight(clampToContainer(searchResultsHeight + step));
      } else if (event.key === "Home") {
        event.preventDefault();
        setSearchResultsHeight(MIN_SEARCH_RESULTS_HEIGHT);
      } else if (event.key === "End") {
        event.preventDefault();
        if (maxSearchResultsHeight !== null) {
          setSearchResultsHeight(maxSearchResultsHeight);
        }
      }
    },
    [
      clampToContainer,
      maxSearchResultsHeight,
      searchResultsHeight,
      setSearchResultsHeight,
    ],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <hr> can't host pointer/keyboard handlers for drag resize.
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-valuemin={MIN_SEARCH_RESULTS_HEIGHT}
      aria-valuemax={maxSearchResultsHeight ?? undefined}
      aria-valuenow={searchResultsHeight}
      aria-label="Resize search results"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className="h-1 shrink-0 cursor-row-resize bg-slate-200 transition-colors hover:bg-sky-400 focus:outline-none focus-visible:bg-sky-500 active:bg-sky-500"
      title="Drag or use up/down arrow keys to resize"
    />
  );
}
