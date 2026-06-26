/**
 * Disclosure chevron. Rendered as an inline SVG so its geometry is
 * pixel-consistent across platforms (unicode triangles ▸/▾ render at
 * wildly different sizes and baselines depending on the system font).
 *
 * Rotates ▸→▾ on expand with the design system's mechanical easing.
 */
export function DisclosureCaret({
  expanded,
  className = "size-4 shrink-0 text-ink/50",
}: {
  expanded: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      style={{
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 150ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
      fill="currentColor"
    >
      <path d="M6 4l5 4-5 4V4z" />
    </svg>
  );
}
