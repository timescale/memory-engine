/**
 * UI-local state: which memory is selected + which tree nodes are expanded.
 *
 * Kept in zustand (not URL or server cache) because it changes often and
 * doesn't need to survive a full reload. The URL separately tracks the
 * `selected` id for shareable-link support; this store syncs from it.
 *
 * Expansion state is tracked independently per tree context:
 *   - "browse" (no filter active): default is collapsed. The set holds
 *     paths the user has explicitly expanded.
 *   - "search" (filter active): default is expanded, so every match is
 *     visible. The set holds paths the user has explicitly collapsed.
 *
 * Splitting the sets lets the two views coexist — applying a filter
 * doesn't perturb the browse state, and clearing the filter restores it
 * exactly as it was.
 */
import { create } from "zustand";

export type TreeContext = "browse" | "search";

interface SelectionState {
  /** Currently-selected memory id, or null when nothing is selected. */
  selectedId: string | null;
  /** Paths explicitly expanded in browse mode (default: collapsed). */
  expandedBrowse: Set<string>;
  /** Paths explicitly collapsed in search mode (default: expanded). */
  collapsedSearch: Set<string>;
}

interface SelectionActions {
  select(id: string | null): void;
  toggleExpanded(context: TreeContext, path: string): void;
  setExpanded(context: TreeContext, path: string, expanded: boolean): void;
  /**
   * Drop entries from the context-specific set that no longer appear in
   * the current tree. Called after tree data changes so stale entries
   * don't leak indefinitely.
   */
  pruneExpanded(context: TreeContext, livePaths: Set<string>): void;
}

export const useSelection = create<SelectionState & SelectionActions>(
  (set) => ({
    selectedId: null,
    expandedBrowse: new Set<string>(),
    collapsedSearch: new Set<string>(),

    select(id) {
      set({ selectedId: id });
    },

    toggleExpanded(context, path) {
      if (context === "browse") {
        set((state) => ({
          expandedBrowse: toggledSet(state.expandedBrowse, path),
        }));
      } else {
        set((state) => ({
          collapsedSearch: toggledSet(state.collapsedSearch, path),
        }));
      }
    },

    setExpanded(context, path, expanded) {
      if (context === "browse") {
        set((state) => {
          const has = state.expandedBrowse.has(path);
          if (has === expanded) return state;
          return {
            expandedBrowse: withMembership(
              state.expandedBrowse,
              path,
              expanded,
            ),
          };
        });
      } else {
        // In search mode the set tracks *collapsed* paths, so flip the
        // incoming "expanded" intent to compute desired membership.
        const shouldBeCollapsed = !expanded;
        set((state) => {
          const has = state.collapsedSearch.has(path);
          if (has === shouldBeCollapsed) return state;
          return {
            collapsedSearch: withMembership(
              state.collapsedSearch,
              path,
              shouldBeCollapsed,
            ),
          };
        });
      }
    },

    pruneExpanded(context, livePaths) {
      const field = context === "browse" ? "expandedBrowse" : "collapsedSearch";
      set((state) => {
        const current = state[field];
        let changed = false;
        const next = new Set<string>();
        for (const path of current) {
          if (livePaths.has(path)) next.add(path);
          else changed = true;
        }
        return changed ? { [field]: next } : state;
      });
    },
  }),
);

/**
 * Selector helper — true when `path` should be rendered as expanded in
 * the given context. Accounts for the asymmetric set semantics (browse =
 * explicit-expanded, search = explicit-collapsed).
 */
export function selectIsExpanded(
  state: SelectionState,
  context: TreeContext,
  path: string,
): boolean {
  if (context === "browse") return state.expandedBrowse.has(path);
  return !state.collapsedSearch.has(path);
}

function toggledSet(prev: Set<string>, path: string): Set<string> {
  const next = new Set(prev);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

function withMembership(
  prev: Set<string>,
  path: string,
  member: boolean,
): Set<string> {
  const next = new Set(prev);
  if (member) next.add(path);
  else next.delete(path);
  return next;
}
