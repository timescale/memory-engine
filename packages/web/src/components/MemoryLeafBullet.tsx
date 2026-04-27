/**
 * Leaf marker. Fixed 16×16 inline-flex box so the dot lands in the same
 * column as the caret above (and stays vertically centered regardless of
 * the text's line height).
 */
export function MemoryLeafBullet() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-4 shrink-0 items-center justify-center text-slate-400"
    >
      <span className="block size-1 rounded-full bg-current" />
    </span>
  );
}
