"use client";

import { usePathname } from "next/navigation";
import { NAV, pathToSlug, slugToHref } from "@/lib/nav";

export function SidebarNav() {
  const pathname = usePathname();
  const currentSlug = pathToSlug(pathname);
  return (
    <nav aria-label="Documentation" className="space-y-7 text-sm">
      {NAV.map((section) => (
        <div key={section.title}>
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/40 mb-2">
            {section.title}
          </div>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive = item.slug === currentSlug;
              return (
                <li key={item.slug}>
                  <a
                    href={slugToHref(item.slug)}
                    className={
                      isActive
                        ? "block border-l-2 border-green pl-[10px] py-1 text-green font-medium"
                        : "block border-l-2 border-transparent pl-[10px] py-1 text-white/65 hover:text-green hover:border-white/20 transition-colors"
                    }
                  >
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
