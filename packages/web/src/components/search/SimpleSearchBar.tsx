/**
 * Simple search bar.
 *
 * A single text input that drives a hybrid semantic+fulltext search, plus
 * the shared [Simple | Advanced] mode toggle and a Clear button. Used in
 * simple mode only; advanced mode uses `AdvancedSearchSection` which
 * carries its own heading + collapse affordance.
 */
import { useFilter } from "../../store/filter.ts";
import { useLayout } from "../../store/layout.ts";
import { ModeToggle } from "./ModeToggle.tsx";

export function SimpleSearchBar() {
  const simple = useFilter((s) => s.simple);
  const setSimple = useFilter((s) => s.setSimple);
  const setMode = useFilter((s) => s.setMode);
  const clear = useFilter((s) => s.clear);
  const setSearchCollapsed = useLayout((s) => s.setSearchCollapsed);

  return (
    <div className="flex items-center gap-2">
      <input
        type="search"
        placeholder="Search memories (hybrid semantic + fulltext)…"
        value={simple}
        onChange={(e) => setSimple(e.target.value)}
        className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
      />

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
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
      >
        Clear
      </button>
    </div>
  );
}
