import { useCallback } from "react";
import { confirmDiscardChangesIfDirty } from "../store/editor.ts";
import { useLayout } from "../store/layout.ts";
import { useSelection } from "../store/selection.ts";

export function useMemorySelection(memoryId: string): {
  selected: boolean;
  selectMemory: () => void;
} {
  const selected = useSelection((s) => s.selectedId === memoryId);
  const select = useSelection((s) => s.select);
  const setSearchPreviewCollapsed = useLayout(
    (s) => s.setSearchPreviewCollapsed,
  );

  const selectMemory = useCallback(() => {
    // An explicit "view this memory" click always reveals the preview pane,
    // even when the clicked row is already the selection.
    setSearchPreviewCollapsed(false);
    if (selected) return;
    if (!confirmDiscardChangesIfDirty()) return;
    select(memoryId);
  }, [memoryId, select, selected, setSearchPreviewCollapsed]);

  return { selected, selectMemory };
}
