/**
 * Top header bar (54px): logo + product name (left), space switcher +
 * account + theme toggle (right). Matches the "Console" handoff: a single
 * bordered bar above the search/controls row.
 */
import { useTheme } from "../../store/theme.ts";
import { AccountCluster } from "../account/AccountCluster.tsx";
import { Logo, MoonIcon, SunIcon } from "../icons.tsx";

export function HeaderBar() {
  return (
    <header className="flex h-[54px] shrink-0 items-center justify-between border-b border-ink/[0.12] px-6">
      <div className="flex items-center gap-[11px]">
        <Logo />
        <span className="text-[15px] font-semibold tracking-[-0.01em]">
          Memory Engine
        </span>
        <span className="pl-0.5 font-mono text-[11px] text-ink/[0.38]">
          v2.0
        </span>
      </div>
      <div className="flex items-center gap-4">
        <AccountCluster />
        <ThemeToggle />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggle);
  const label =
    theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={theme === "dark"}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-ink/[0.16] text-ink/70 transition-colors hover:border-ink hover:text-ink"
    >
      {theme === "dark" ? (
        <SunIcon className="h-4 w-4" />
      ) : (
        <MoonIcon className="h-4 w-4" />
      )}
    </button>
  );
}
