/**
 * Persisted UI layout state — sidebar width (and room for more later).
 *
 * Width is stored in localStorage via zustand's `persist` middleware so
 * the user's chosen sidebar width survives reloads as well as normal
 * in-session navigation.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 720;
export const DEFAULT_SIDEBAR_WIDTH = 320;

interface LayoutState {
  sidebarWidth: number;
}

interface LayoutActions {
  setSidebarWidth(width: number): void;
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
      setSidebarWidth(width) {
        set({ sidebarWidth: clampSidebarWidth(width) });
      },
    }),
    {
      name: "me-web:layout",
      version: 1,
    },
  ),
);
