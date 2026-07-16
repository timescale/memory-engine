/**
 * Light/dark theme state.
 *
 * The initial theme is resolved pre-paint by an inline script in index.html
 * (localStorage `me-theme`, else `prefers-color-scheme`) which stamps the
 * `dark` class on <html>; this store reads that class as its initial value so
 * the two never disagree. Toggling flips the class and persists the choice.
 */
import { create } from "zustand";

export type Theme = "light" | "dark";

const STORAGE_KEY = "me-theme";

function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
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
