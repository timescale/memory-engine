/**
 * Disclosure chevron. Rendered as an inline SVG so its geometry is
 * pixel-consistent across platforms (unicode triangles ▸/▾ render at
 * wildly different sizes and baselines depending on the system font).
 */
export function DisclosureCaret({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-slate-400 transition-transform"
      style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
      fill="currentColor"
    >
      <path d="M6 4l5 4-5 4V4z" />
    </svg>
  );
}
