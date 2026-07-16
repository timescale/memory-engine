/**
 * Light/dark theme state.
 *
 * The initial theme is resolved pre-paint by `public/theme-init.js` (a
 * blocking script loaded from index.html's <head>: localStorage `me-theme`,
 * else `prefers-color-scheme`) which stamps the `dark` class on <html>; this
 * store reads that class as its initial value so the two never disagree.
 * Toggling flips the class and persists the choice.
 */
import { create } from "zustand";

export type Theme = "light" | "dark";

const STORAGE_KEY = "me-theme";

function currentTheme(): Theme {
  // Guard `document` so importing the store outside a browser (tests,
  // tooling) can't throw at module evaluation time.
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

interface ThemeState {
  theme: Theme;
  toggle(): void;
}

export const useTheme = create<ThemeState>((set) => ({
  theme: currentTheme(),

  toggle() {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still applies.
    }
    set({ theme: next });
  },
}));
