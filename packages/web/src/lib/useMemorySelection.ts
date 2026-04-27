import { useCallback } from "react";
import { confirmDiscardChangesIfDirty } from "../store/editor.ts";
import { useSelection } from "../store/selection.ts";

export function useMemorySelection(memoryId: string): {
  selected: boolean;
  selectMemory: () => void;
} {
  const selected = useSelection((s) => s.selectedId === memoryId);
  const select = useSelection((s) => s.select);

  const selectMemory = useCallback(() => {
    if (selected) return;
    if (!confirmDiscardChangesIfDirty()) return;
    select(memoryId);
  }, [memoryId, select, selected]);

  return { selected, selectMemory };
}
