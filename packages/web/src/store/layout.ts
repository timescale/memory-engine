/**
 * Persisted UI layout state — sidebar width (and room for more later).
 *
 * Width is stored in localStorage via zustand's `persist` middleware so
 * the user's chosen sidebar width survives reloads as well as normal
 * in-session navigation.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  clampSearchResultsHeight,
  DEFAULT_SEARCH_RESULTS_HEIGHT,
} from "../lib/split-pane.ts";

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 720;
export const DEFAULT_SIDEBAR_WIDTH = 320;

interface LayoutState {
  sidebarWidth: number;
  /** When true, the header's search pane is hidden and only the summary is shown. */
  searchCollapsed: boolean;
  /** Height in pixels of the relevance-results pane above the tree. */
  searchResultsHeight: number;
}

interface LayoutActions {
  setSidebarWidth(width: number): void;
  setSearchCollapsed(collapsed: boolean): void;
  toggleSearchCollapsed(): void;
  setSearchResultsHeight(height: number): void;
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  if (width < MIN_SIDEBAR_WIDTH) return MIN_SIDEBAR_WIDTH;
  if (width > MAX_SIDEBAR_WIDTH) return MAX_SIDEBAR_WIDTH;
  return Math.round(width);
}

export const useLayout = create<LayoutState & LayoutActions>()(
  persist(
    (set) => ({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      searchCollapsed: false,
      searchResultsHeight: DEFAULT_SEARCH_RESULTS_HEIGHT,
      setSidebarWidth(width) {
        set({ sidebarWidth: clampSidebarWidth(width) });
      },
      setSearchCollapsed(collapsed) {
        set({ searchCollapsed: collapsed });
      },
      toggleSearchCollapsed() {
        set((state) => ({ searchCollapsed: !state.searchCollapsed }));
      },
      setSearchResultsHeight(height) {
        set({ searchResultsHeight: clampSearchResultsHeight(height) });
      },
    }),
    {
      name: "me-web:layout",
      version: 1,
    },
  ),
);
