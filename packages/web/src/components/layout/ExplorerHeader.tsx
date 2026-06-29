/**
 * Sidebar header — an "explorer" eyebrow and a Solar-Flare count pill showing
 * the total number of memories in the active space.
 */
export function ExplorerHeader({ count }: { count: number | null }) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-ink/10 px-4 py-[13px]">
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink/50">
        explorer
      </span>
      {count !== null && (
        <span className="rounded-full bg-solar px-2 py-0.5 font-mono text-[11px] font-semibold text-ink">
          {count.toLocaleString()}
        </span>
      )}
    </div>
  );
}
