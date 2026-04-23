/**
 * Global UI state: context menu + modal dialogs.
 *
 * Kept in zustand so tree rows can dispatch without the App component
 * prop-drilling handlers through every level.
 */
import { create } from "zustand";

export type ContextMenuTarget =
  | { kind: "memory"; id: string; title: string }
  | { kind: "path"; path: string };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

interface UiState {
  contextMenu: ContextMenuState | null;
  /** Id of the memory currently awaiting delete confirmation. */
  deleteMemory: { id: string; title: string } | null;
  /** Tree path currently awaiting subtree-delete confirmation. */
  deleteTreePath: string | null;
}

interface UiActions {
  openContextMenu(menu: ContextMenuState): void;
  closeContextMenu(): void;
  askDeleteMemory(args: { id: string; title: string }): void;
  askDeleteTree(path: string): void;
  closeDialogs(): void;
}

export const useUi = create<UiState & UiActions>((set) => ({
  contextMenu: null,
  deleteMemory: null,
  deleteTreePath: null,

  openContextMenu(menu) {
    set({ contextMenu: menu });
  },
  closeContextMenu() {
    set({ contextMenu: null });
  },
  askDeleteMemory(args) {
    set({ deleteMemory: args, contextMenu: null });
  },
  askDeleteTree(path) {
    set({ deleteTreePath: path, contextMenu: null });
  },
  closeDialogs() {
    set({ deleteMemory: null, deleteTreePath: null });
  },
}));
