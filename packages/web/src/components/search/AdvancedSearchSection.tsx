/**
 * Advanced search section — heading + filter overlay.
 *
 * The heading is a single clickable control (caret + "Advanced filter")
 * that toggles the panel. The expanded panel floats as an overlay above
 * the body (rather than pushing it down and leaving an awkward sliver of
 * explorer/tree underneath); the Search button inside it closes the
 * overlay. When collapsed, the section renders a chip summary of the
 * active filters so the user can see what's in effect without expanding.
 * Clear and the Simple/Advanced mode toggle stay visible in both states.
 */
import { useRefreshMemories } from "../../api/queries.ts";
import { summarizeFilter, useFilter } from "../../store/filter.ts";
import { useLayout } from "../../store/layout.ts";
import { DisclosureCaret } from "../DisclosureCaret.tsx";
import { RefreshIcon } from "../icons.tsx";
import { AdvancedSearchPanel } from "./AdvancedSearchPanel.tsx";
import { ModeToggle } from "./ModeToggle.tsx";

export function AdvancedSearchSection() {
  const filter = useFilter();
  const setMode = useFilter((s) => s.setMode);
  const clear = useFilter((s) => s.clear);
  const searchCollapsed = useLayout((s) => s.searchCollapsed);
  const setSearchCollapsed = useLayout((s) => s.setSearchCollapsed);
  const toggleSearchCollapsed = useLayout((s) => s.toggleSearchCollapsed);
  const refresh = useRefreshMemories();

  const { chips, hasFilter } = summarizeFilter(filter);

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={toggleSearchCollapsed}
          aria-expanded={!searchCollapsed}
          className="-ml-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-1 text-[13px] font-semibold text-ink hover:text-ink"
          title={searchCollapsed ? "Show filter fields" : "Hide filter fields"}
        >
          <DisclosureCaret expanded={!searchCollapsed} />
          Advanced filter
        </button>

        {searchCollapsed && hasFilter && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip}
                className="inline-block max-w-full truncate rounded-full border border-ink/[0.16] px-2.5 py-0.5 font-mono text-[11px] text-ink/80"
                title={chip}
              >
                {chip}
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <ModeToggle current="advanced" onChange={setMode} />

          <button
            type="button"
            onClick={clear}
            title="Clear all search filters"
            className="flex h-[42px] items-center rounded-lg border border-ink/[0.18] px-4 text-[13px] font-medium transition-colors hover:border-ink"
          >
            Clear
          </button>

          <button
            type="button"
            onClick={refresh}
            title="Re-run the query for the freshest results"
            aria-label="Refresh"
            className="flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-ink/[0.18] text-ink/70 transition-colors hover:border-ink hover:text-ink"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {!searchCollapsed && (
        <div className="absolute inset-x-0 top-full z-30 mt-3 max-h-[min(70vh,640px)] overflow-y-auto overflow-x-hidden rounded-lg border border-ink/[0.12] bg-white shadow-xl">
          <AdvancedSearchPanel onSearch={() => setSearchCollapsed(true)} />
        </div>
      )}
    </div>
  );
}
