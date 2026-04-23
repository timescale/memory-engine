/**
 * Top-bar search UI.
 *
 * Step 8: simple mode only — a single text input that drives a hybrid
 * semantic+fulltext search. A `[Simple | Advanced]` mode toggle is rendered
 * but the Advanced panel itself is wired in step 9.
 *
 * The "Clear" button is always visible (even when fields are empty) so the
 * affordance is consistent.
 */
import { type FilterMode, useFilter } from "../../store/filter.ts";

export function SimpleSearchBar() {
  const mode = useFilter((s) => s.mode);
  const simple = useFilter((s) => s.simple);
  const setSimple = useFilter((s) => s.setSimple);
  const setMode = useFilter((s) => s.setMode);
  const clear = useFilter((s) => s.clear);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        {mode === "simple" ? (
          <input
            type="search"
            placeholder="Search memories (hybrid semantic + fulltext)…"
            value={simple}
            onChange={(e) => setSimple(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
        ) : (
          <p className="text-xs text-slate-500">
            Advanced filter active — use the panel below to edit fields.
          </p>
        )}
      </div>

      <ModeToggle current={mode} onChange={setMode} />

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

function ModeToggle({
  current,
  onChange,
}: {
  current: FilterMode;
  onChange: (mode: FilterMode) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-xs">
      <ToggleButton
        active={current === "simple"}
        onClick={() => onChange("simple")}
        label="Simple"
      />
      <ToggleButton
        active={current === "advanced"}
        onClick={() => onChange("advanced")}
        label="Advanced"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded px-2 py-1 transition-colors",
        active
          ? "bg-sky-600 text-white"
          : "text-slate-600 hover:text-slate-900",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
