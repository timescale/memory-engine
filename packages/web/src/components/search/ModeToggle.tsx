/**
 * Shared [Simple | Advanced] mode toggle used by both the simple search
 * bar and the advanced search section.
 */
import type { FilterMode } from "../../store/filter.ts";

export function ModeToggle({
  current,
  onChange,
}: {
  current: FilterMode;
  onChange: (mode: FilterMode) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm">
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
        "rounded px-3 py-1.5 transition-colors",
        active
          ? "bg-sky-600 text-white"
          : "text-slate-600 hover:text-slate-900",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
