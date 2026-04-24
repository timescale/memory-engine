/**
 * Advanced search section — heading + collapsible panel.
 *
 * The heading is a single clickable control (caret + "Advanced filter")
 * that toggles the panel. When collapsed, the section renders a chip
 * summary of the active filters underneath the heading so the user can
 * see what's in effect without expanding. Clear and the Simple/Advanced
 * mode toggle stay visible in both states.
 */
import { summarizeFilter, useFilter } from "../../store/filter.ts";
import { useLayout } from "../../store/layout.ts";
import { AdvancedSearchPanel } from "./AdvancedSearchPanel.tsx";
import { ModeToggle } from "./ModeToggle.tsx";

export function AdvancedSearchSection() {
  const filter = useFilter();
  const setMode = useFilter((s) => s.setMode);
  const clear = useFilter((s) => s.clear);
  const searchCollapsed = useLayout((s) => s.searchCollapsed);
  const toggleSearchCollapsed = useLayout((s) => s.toggleSearchCollapsed);

  const { chips, hasFilter } = summarizeFilter(filter);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={toggleSearchCollapsed}
          aria-expanded={!searchCollapsed}
          className="-ml-1 inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
          title={searchCollapsed ? "Show filter fields" : "Hide filter fields"}
        >
          <span
            aria-hidden="true"
            className="inline-block w-3 text-xs text-slate-500"
          >
            {searchCollapsed ? "▸" : "▾"}
          </span>
          Advanced filter
        </button>

        {searchCollapsed && hasFilter && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip}
                className="inline-block max-w-full truncate rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-800"
                title={chip}
              >
                {chip}
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ModeToggle current="advanced" onChange={setMode} />

          <button
            type="button"
            onClick={clear}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            Clear
          </button>
        </div>
      </div>

      {!searchCollapsed && (
        <div className="mt-3">
          <AdvancedSearchPanel />
        </div>
      )}
    </div>
  );
}
