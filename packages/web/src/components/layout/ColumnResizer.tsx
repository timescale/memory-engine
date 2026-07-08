/**
 * Vertical drag handle that resizes the column to its left.
 *
 * Used between the tree sidebar and the main area, and between the
 * search-results column and the editor. Pointer drag reports the new width
 * through `onChange` (the layout store clamps and persists it); keyboard
 * users can step the width with arrow keys (Shift for a larger step) or
 * jump to the min/max with Home/End.
 *
 * While dragging we set `cursor: col-resize` and `user-select: none` on
 * the body so the cursor stays consistent and text doesn't get selected
 * mid-drag.
 */
import { useCallback, useRef } from "react";

const KEYBOARD_STEP_PX = 16;
const KEYBOARD_STEP_PX_LARGE = 64;

export function ColumnResizer({
  label,
  max,
  min,
  onChange,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange(width: number): void;
  value: number;
}) {
  // Keep drag-start coordinates in a ref so the move/up listeners don't
  // have to rebind on every mouse event.
  const dragStartRef = useRef<{ clientX: number; width: number } | null>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragStartRef.current = {
        clientX: event.clientX,
        width: value,
      };

      const handleMove = (moveEvent: PointerEvent) => {
        const start = dragStartRef.current;
        if (!start) return;
        const nextWidth = start.width + (moveEvent.clientX - start.clientX);
        onChange(nextWidth);
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
    [value, onChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEYBOARD_STEP_PX_LARGE : KEYBOARD_STEP_PX;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onChange(value - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onChange(value + step);
      } else if (event.key === "Home") {
        event.preventDefault();
        onChange(min);
      } else if (event.key === "End") {
        event.preventDefault();
        onChange(max);
      }
    },
    [value, onChange, min, max],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <hr> can't host pointer/keyboard handlers for drag resize.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={label}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className="w-px shrink-0 cursor-col-resize bg-ink/[0.12] transition-colors hover:bg-ink/40 focus:outline-none focus-visible:bg-tiger-blue active:bg-tiger-blue"
      title="Drag or use arrow keys to resize"
    />
  );
}
