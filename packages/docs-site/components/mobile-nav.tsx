"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SidebarNav } from "./sidebar-nav";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer when route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keying off pathname
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        className="lg:hidden fixed bottom-4 right-4 z-30 inline-flex items-center gap-2 bg-green text-black border border-black px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] shadow-lg hover:bg-[#6df09a] transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M1 3h14M1 8h14M1 13h14"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        Menu
      </button>

      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          {/* Backdrop */}
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/70"
            onClick={() => setOpen(false)}
          />
          {/* Drawer */}
          <div className="absolute top-0 left-0 bottom-0 w-[85%] max-w-[320px] bg-black border-r border-white/15 overflow-y-auto px-5 py-5">
            <div className="flex items-center justify-between mb-6">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
                Documentation
              </span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="text-white/60 hover:text-green transition-colors"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3 3l12 12M15 3L3 15"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
            </div>
            <SidebarNav />
          </div>
        </div>
      )}
    </>
  );
}
