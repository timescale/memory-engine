/**
 * Vertical drag handle that resizes the sidebar.
 *
 * The handle sits between the tree (`<aside>`) and the editor (`<main>`).
 * Pointer drag updates the persisted `sidebarWidth` in the layout store;
 * keyboard users can also step the width with arrow keys (Shift for a
 * larger step) or jump to the min/max with Home/End.
 *
 * While dragging we set `cursor: col-resize` and `user-select: none` on
 * the body so the cursor stays consistent and text doesn't get selected
 * mid-drag.
 */
import { useCallback, useRef } from "react";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useLayout,
} from "../../store/layout.ts";

const KEYBOARD_STEP_PX = 16;
const KEYBOARD_STEP_PX_LARGE = 64;

export function SidebarResizer() {
  const sidebarWidth = useLayout((s) => s.sidebarWidth);
  const setSidebarWidth = useLayout((s) => s.setSidebarWidth);

  // Keep drag-start coordinates in a ref so the move/up listeners don't
  // have to rebind on every mouse event.
  const dragStartRef = useRef<{ clientX: number; width: number } | null>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragStartRef.current = {
        clientX: event.clientX,
        width: sidebarWidth,
      };

      const handleMove = (moveEvent: PointerEvent) => {
        const start = dragStartRef.current;
        if (!start) return;
        const nextWidth = start.width + (moveEvent.clientX - start.clientX);
        setSidebarWidth(nextWidth);
      };

      const handleUp = () => {
        dragStartRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [sidebarWidth, setSidebarWidth],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEYBOARD_STEP_PX_LARGE : KEYBOARD_STEP_PX;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setSidebarWidth(sidebarWidth - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setSidebarWidth(sidebarWidth + step);
      } else if (event.key === "Home") {
        event.preventDefault();
        setSidebarWidth(MIN_SIDEBAR_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        setSidebarWidth(MAX_SIDEBAR_WIDTH);
      }
    },
    [sidebarWidth, setSidebarWidth],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <hr> can't host pointer/keyboard handlers for drag resize.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={sidebarWidth}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-label="Resize sidebar"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className="w-1 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-sky-400 focus:outline-none focus-visible:bg-sky-500 active:bg-sky-500"
      title="Drag or use arrow keys to resize"
    />
  );
}
