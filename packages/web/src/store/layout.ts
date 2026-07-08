/**
 * Persisted UI layout state — sidebar width, search-results column width
 * (and room for more later).
 *
 * Widths are stored in localStorage via zustand's `persist` middleware so
 * the user's chosen pane sizes survive reloads as well as normal
 * in-session navigation.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 720;
export const DEFAULT_SIDEBAR_WIDTH = 300;

export const MIN_SEARCH_COLUMN_WIDTH = 280;
export const MAX_SEARCH_COLUMN_WIDTH = 640;
export const DEFAULT_SEARCH_COLUMN_WIDTH = 380;

interface LayoutState {
  sidebarWidth: number;
  /** When true, the header's search pane is hidden and only the summary is shown. */
  searchCollapsed: boolean;
  /** Width in pixels of the relevance-results column between tree and editor. */
  searchColumnWidth: number;
  /**
   * When true (and a search is active), the preview/editor pane is hidden
   * and the results column grows to fill the space. Selecting a result
   * reveals the preview again.
   */
  searchPreviewCollapsed: boolean;
}

interface LayoutActions {
  setSidebarWidth(width: number): void;
  setSearchCollapsed(collapsed: boolean): void;
  toggleSearchCollapsed(): void;
  setSearchColumnWidth(width: number): void;
  setSearchPreviewCollapsed(collapsed: boolean): void;
}

export function clampSidebarWidth(width: number): number {
  return clampWidth(
    width,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    DEFAULT_SIDEBAR_WIDTH,
  );
}

export function clampSearchColumnWidth(width: number): number {
  return clampWidth(
    width,
    MIN_SEARCH_COLUMN_WIDTH,
    MAX_SEARCH_COLUMN_WIDTH,
    DEFAULT_SEARCH_COLUMN_WIDTH,
  );
}

function clampWidth(
  width: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(width)) return fallback;
  if (width < min) return min;
  if (width > max) return max;
  return Math.round(width);
}

export const useLayout = create<LayoutState & LayoutActions>()(
  persist(
    (set) => ({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      searchCollapsed: false,
      searchColumnWidth: DEFAULT_SEARCH_COLUMN_WIDTH,
      searchPreviewCollapsed: false,
      setSidebarWidth(width) {
        set({ sidebarWidth: clampSidebarWidth(width) });
      },
      setSearchCollapsed(collapsed) {
        set({ searchCollapsed: collapsed });
      },
      toggleSearchCollapsed() {
        set((state) => ({ searchCollapsed: !state.searchCollapsed }));
      },
      setSearchColumnWidth(width) {
        set({ searchColumnWidth: clampSearchColumnWidth(width) });
      },
      setSearchPreviewCollapsed(collapsed) {
        set({ searchPreviewCollapsed: collapsed });
      },
    }),
    {
      name: "me-web:layout",
      // v2: `searchResultsHeight` (results pane stacked above the tree in the
      // sidebar) replaced by `searchColumnWidth` (results column in the main
      // pane).
      version: 2,
      migrate(persisted) {
        const { searchResultsHeight: _dropped, ...rest } = (persisted ??
          {}) as Record<string, unknown>;
        return rest;
      },
    },
  ),
);
