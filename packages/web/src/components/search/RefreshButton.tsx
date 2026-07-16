/**
 * Refresh button shared by the simple and advanced search bars. The icon
 * does one full turn (design-system mechanical easing) on each click as
 * feedback that the query was re-run.
 */
import { useState } from "react";
import { RefreshIcon } from "../icons.tsx";

export function RefreshButton({ onClick }: { onClick: () => void }) {
  // Counter, not a boolean: bumping the icon's key remounts it, so a click
  // mid-spin restarts the animation instead of being swallowed.
  const [spin, setSpin] = useState(0);

  return (
    <button
      type="button"
      onClick={() => {
        setSpin((n) => n + 1);
        onClick();
      }}
      title="Re-run the query for the freshest results"
      aria-label="Refresh"
      className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-ink/[0.18] text-ink/70 transition-colors hover:border-ink hover:text-ink"
    >
      <RefreshIcon
        key={spin}
        className={
          spin > 0
            ? "animate-[spin_0.5s_cubic-bezier(0.22,1,0.36,1)]"
            : undefined
        }
        onAnimationEnd={() => setSpin(0)}
      />
    </button>
  );
}
