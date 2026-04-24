/**
 * Editor state — exposes a global `dirty` flag so the tree view can prompt
 * before discarding unsaved changes when the user selects a new memory.
 *
 * Local state (text, parse error, save in progress) lives inside the editor
 * component via `useState` — putting it in a global store would force every
 * keystroke through zustand for no gain.
 */
import { create } from "zustand";

interface EditorState {
  dirty: boolean;
}

interface EditorActions {
  setDirty(dirty: boolean): void;
}

export const useEditor = create<EditorState & EditorActions>((set) => ({
  dirty: false,
  setDirty(dirty) {
    set((state) => (state.dirty === dirty ? state : { dirty }));
  },
}));

/**
 * Convenience — ask the user to confirm discarding unsaved changes if the
 * editor is dirty. Returns true to proceed, false to abort.
 */
export function confirmDiscardChangesIfDirty(): boolean {
  if (!useEditor.getState().dirty) return true;
  return window.confirm("You have unsaved changes. Discard them and continue?");
}
