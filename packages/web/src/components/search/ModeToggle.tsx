/**
 * Shared [Simple | Advanced] segmented mode toggle used by both the simple
 * search bar and the advanced search section. Active segment is Solar Flare.
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
    <div className="flex h-[42px] shrink-0 overflow-hidden rounded-lg border border-ink/[0.18]">
      <ToggleButton
        active={current === "simple"}
        onClick={() => onChange("simple")}
        label="Simple"
        title="Switch to simple search"
      />
      <ToggleButton
        active={current === "advanced"}
        onClick={() => onChange("advanced")}
        label="Advanced"
        title="Switch to advanced search with filter fields"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        "flex items-center px-4 text-[13px] transition-colors duration-150",
        active
          ? "bg-solar font-semibold text-solar-ink hover:bg-solar-hover"
          : "text-ink/55 hover:text-ink",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
