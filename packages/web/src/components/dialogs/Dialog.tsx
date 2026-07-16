/**
 * Minimal modal dialog — backdrop + centered panel + Escape-to-close.
 *
 * Hand-rolled (not `<dialog>`) so the styling matches the rest of the app
 * and we have control over backdrop click-to-dismiss behavior.
 */
import { useEffect, useRef } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title bar content. */
  title?: React.ReactNode;
  children: React.ReactNode;
  /** Footer row (action buttons). */
  footer?: React.ReactNode;
}

export function Dialog({ open, onClose, title, children, footer }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      {/* Backdrop: plain button so a11y lint is satisfied and clicking it
          (or pressing Enter/Space while focused) closes the dialog. */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/40"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-ink/[0.14] bg-surface shadow-xl focus:outline-none"
      >
        {title && (
          <header className="border-b border-ink/[0.12] px-5 py-3 text-[14px] font-semibold text-ink">
            {title}
          </header>
        )}
        <div className="px-5 py-4 text-[13px] text-ink/70">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-ink/[0.12] bg-ink/[0.02] px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
