/**
 * Memory-leaf marker.
 *
 * Plain: a 5px square bullet in the current text color at 45% opacity.
 * Selected: the active-row indicator — a 6px Solar-Flare LED dot with a soft
 * glow ring. (The selected row's gray fill lives on the row itself; this is
 * never a left-border stripe.)
 */
export function MemoryLeafBullet({ selected = false }: { selected?: boolean }) {
  if (selected) {
    return (
      <span
        aria-hidden="true"
        className="block size-1.5 shrink-0 rounded-full bg-solar shadow-[0_0_0_3px_rgba(241,255,92,0.3)]"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="block size-[5px] shrink-0 rounded-[1px] bg-current opacity-45"
    />
  );
}
