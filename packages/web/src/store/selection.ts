/**
 * UI-local state: which memory is selected + which tree nodes are expanded.
 *
 * Kept in zustand (not URL or server cache) because it changes often and
 * doesn't need to survive a full reload. The URL separately tracks the
 * `selected` id for shareable-link support; this store syncs from it.
 */
import { create } from "zustand";
import { ROOT_PATH } from "../lib/tree-build.ts";

interface SelectionState {
  /** Currently-selected memory id, or null when nothing is selected. */
  selectedId: string | null;
  /**
   * Paths that are expanded in the tree. The synthetic root is expanded by
   * default; every other path starts collapsed. Mutations replace the Set
   * reference so React re-renders.
   */
  expandedPaths: Set<string>;
}

interface SelectionActions {
  select(id: string | null): void;
  toggleExpanded(path: string): void;
  setExpanded(path: string, expanded: boolean): void;
  /**
   * Prune expanded paths that no longer exist in the current tree. Called
   * after filter changes so stale entries don't leak.
   */
  pruneExpanded(livePaths: Set<string>): void;
}

export const useSelection = create<SelectionState & SelectionActions>(
  (set) => ({
    selectedId: null,
    expandedPaths: new Set<string>([ROOT_PATH]),

    select(id) {
      set({ selectedId: id });
    },

    toggleExpanded(path) {
      set((state) => {
        const next = new Set(state.expandedPaths);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return { expandedPaths: next };
      });
    },

    setExpanded(path, expanded) {
      set((state) => {
        if (state.expandedPaths.has(path) === expanded) return state;
        const next = new Set(state.expandedPaths);
        if (expanded) next.add(path);
        else next.delete(path);
        return { expandedPaths: next };
      });
    },

    pruneExpanded(livePaths) {
      set((state) => {
        let changed = false;
        const next = new Set<string>();
        for (const path of state.expandedPaths) {
          if (livePaths.has(path)) next.add(path);
          else changed = true;
        }
        // Always keep the synthetic root expanded after prune.
        if (!next.has(ROOT_PATH)) {
          next.add(ROOT_PATH);
          changed = true;
        }
        return changed ? { expandedPaths: next } : state;
      });
    },
  }),
);
