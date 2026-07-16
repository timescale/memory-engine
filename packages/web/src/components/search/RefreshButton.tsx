/**
 * Refresh button shared by the simple and advanced search bars. The icon
 * does one full turn (design-system mechanical easing) on each click as
 * feedback that the query was re-run.
 */
import { useState } from "react";
import { RefreshIcon } from "../icons.tsx";

export function RefreshButton({ onClick }: { onClick: () => void }) {
  const [spinning, setSpinning] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        setSpinning(true);
        onClick();
      }}
      title="Re-run the query for the freshest results"
      aria-label="Refresh"
      className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-ink/[0.18] text-ink/70 transition-colors hover:border-ink hover:text-ink"
    >
      <RefreshIcon
        className={
          spinning
            ? "animate-[spin_0.5s_cubic-bezier(0.22,1,0.36,1)]"
            : undefined
        }
        onAnimationEnd={() => setSpinning(false)}
      />
    </button>
  );
}
