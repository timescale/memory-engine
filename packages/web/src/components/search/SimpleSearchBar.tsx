/**
 * Simple search bar.
 *
 * A single text input that drives a hybrid semantic+fulltext search, plus
 * the shared [Simple | Advanced] mode toggle and a Clear button. Used in
 * simple mode only; advanced mode uses `AdvancedSearchSection` which
 * carries its own heading + collapse affordance.
 */
import { useRefreshMemories } from "../../api/queries.ts";
import { useFilter } from "../../store/filter.ts";
import { useLayout } from "../../store/layout.ts";
import { RefreshIcon, SearchIcon } from "../icons.tsx";
import { ModeToggle } from "./ModeToggle.tsx";

export function SimpleSearchBar() {
  const simple = useFilter((s) => s.simple);
  const setSimple = useFilter((s) => s.setSimple);
  const setMode = useFilter((s) => s.setMode);
  const clear = useFilter((s) => s.clear);
  const setSearchCollapsed = useLayout((s) => s.setSearchCollapsed);
  const refresh = useRefreshMemories();

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-[42px] flex-1 items-center gap-[11px] rounded-lg border border-ink/[0.18] bg-ink/[0.03] px-3.5 transition-colors focus-within:border-ink">
        <SearchIcon className="shrink-0 text-ink/50" />
        <input
          type="search"
          placeholder="search memories — hybrid semantic + full-text…"
          value={simple}
          onChange={(e) => setSimple(e.target.value)}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink placeholder:text-ink/40 focus:outline-none"
        />
      </div>

      <ModeToggle
        current="simple"
        onChange={(mode) => {
          // Switching into advanced always opens the panel so the user
          // sees the fields they just asked for; the collapse state
          // resumes its persisted value on subsequent toggles.
          if (mode === "advanced") setSearchCollapsed(false);
          setMode(mode);
        }}
      />

      <button
        type="button"
        onClick={clear}
        title="Clear all search filters"
        className="flex h-[42px] shrink-0 items-center rounded-lg border border-ink/[0.18] px-4 text-[13px] font-medium transition-colors hover:border-ink"
      >
        Clear
      </button>

      <button
        type="button"
        onClick={refresh}
        title="Re-run the query for the freshest results"
        aria-label="Refresh"
        className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-ink/[0.18] text-ink/70 transition-colors hover:border-ink hover:text-ink"
      >
        <RefreshIcon />
      </button>
    </div>
  );
}
