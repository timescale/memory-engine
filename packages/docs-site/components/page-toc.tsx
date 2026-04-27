"use client";

import { useEffect, useState } from "react";
import type { TocEntry } from "@/lib/markdown";

export function PageToc({ toc }: { toc: TocEntry[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (toc.length === 0) return;
    const headingEls = toc
      .map((entry) => document.getElementById(entry.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headingEls.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const first = visible[0];
          if (first) setActiveId(first.target.id);
        }
      },
      {
        rootMargin: "-90px 0px -70% 0px",
        threshold: [0, 1],
      },
    );

    for (const el of headingEls) observer.observe(el);
    return () => observer.disconnect();
  }, [toc]);

  if (toc.length === 0) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/40 mb-3">
        On this page
      </div>
      <ul className="space-y-1.5 border-l border-white/10">
        {toc.map((entry) => {
          const isActive = entry.id === activeId;
          return (
            <li key={entry.id}>
              <a
                href={`#${entry.id}`}
                className={
                  (isActive
                    ? "border-l-2 border-green text-green -ml-px "
                    : "border-l-2 border-transparent text-white/55 hover:text-green -ml-px ") +
                  (entry.level === 3 ? "pl-6 " : "pl-3 ") +
                  "block py-0.5 transition-colors"
                }
              >
                {entry.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
