export function Footer() {
  return (
    <footer className="mt-16 border-t border-white/10 bg-black">
      <div className="mx-auto max-w-[1440px] px-4 md:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 py-8">
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-white/70">
            memory engine
          </span>
          <div className="flex items-center gap-6">
            <a
              href="https://memory.build"
              className="font-mono text-xs uppercase tracking-[0.08em] text-white/50 hover:text-green transition-colors"
            >
              home
            </a>
            <a
              href="https://github.com/timescale/memory-engine"
              className="font-mono text-xs uppercase tracking-[0.08em] text-white/50 hover:text-green transition-colors"
            >
              github
            </a>
            <a
              href="/agents.txt"
              className="font-mono text-xs uppercase tracking-[0.08em] text-white/50 hover:text-green transition-colors"
            >
              agents.txt
            </a>
          </div>
          <span className="font-mono text-xs text-white/40 tracking-[0.04em]">
            from the creators of TimescaleDB
          </span>
        </div>
      </div>
    </footer>
  );
}
