import { getNeighbors, slugToHref } from "@/lib/nav";

export function PrevNext({ slug }: { slug: string }) {
  const { prev, next } = getNeighbors(slug);
  if (!prev && !next) return null;
  return (
    <nav
      aria-label="Page navigation"
      className="mt-16 pt-8 border-t border-white/10 grid grid-cols-2 gap-4"
    >
      <div>
        {prev && (
          <a
            href={slugToHref(prev.slug)}
            className="block group border border-white/10 hover:border-green/60 px-4 py-3 transition-colors"
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">
              ← Previous
            </div>
            <div className="text-sm text-white/85 group-hover:text-green transition-colors">
              {prev.label}
            </div>
          </a>
        )}
      </div>
      <div className="text-right">
        {next && (
          <a
            href={slugToHref(next.slug)}
            className="block group border border-white/10 hover:border-green/60 px-4 py-3 transition-colors"
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/40 mb-1">
              Next →
            </div>
            <div className="text-sm text-white/85 group-hover:text-green transition-colors">
              {next.label}
            </div>
          </a>
        )}
      </div>
    </nav>
  );
}
