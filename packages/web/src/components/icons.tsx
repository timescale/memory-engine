/**
 * Inline SVG icons for product chrome.
 *
 * The design system specifies Phosphor Icons in production, but this app has
 * standardized on dependency-free inline SVGs (1.7px stroke) at equivalent
 * sizes — matching the handoff prototype exactly. The logo is the bespoke
 * "memory cell" mark (a placeholder Memory Engine logo).
 */

/** Memory-cell logo mark — 2×2 grid of rounded cells in a rounded square. */
export function Logo({ className = "block" }: { className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="2.6"
        y="2.6"
        width="18.8"
        height="18.8"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="6.4"
        y="6.4"
        width="4.6"
        height="4.6"
        rx="1.2"
        fill="currentColor"
      />
      <rect x="13" y="6.4" width="4.6" height="4.6" rx="1.2" fill="#F1FF5C" />
      <rect x="6.4" y="13" width="4.6" height="4.6" rx="1.2" fill="#F1FF5C" />
      <rect
        x="13"
        y="13"
        width="4.6"
        height="4.6"
        rx="1.2"
        fill="currentColor"
      />
    </svg>
  );
}

/** Magnifier — leading icon for the search field. */
export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/** Circular-arrow refresh glyph for the search bar's Refresh button. */
export function RefreshIcon({
  className,
  onAnimationEnd,
}: {
  className?: string;
  onAnimationEnd?: () => void;
}) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      onAnimationEnd={onAnimationEnd}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/** Sun glyph — theme toggle button while dark mode is active. */
export function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </svg>
  );
}

/** Moon glyph — theme toggle button while light mode is active. */
export function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

/** X glyph for close/hide controls (e.g. hiding the search preview pane). */
export function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
