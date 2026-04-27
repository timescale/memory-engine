import { LogoSVG } from "./logo";

export function Navbar() {
  return (
    <nav className="sticky top-0 z-40 w-full bg-black border-b border-white/10 backdrop-blur supports-[backdrop-filter]:bg-black/85">
      <div className="mx-auto max-w-[1440px] px-4 md:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14 md:h-16">
          <a
            href="https://memory.build"
            className="flex items-center gap-3 group"
            aria-label="memory engine -- back to home"
          >
            <LogoSVG size={20} variant="green" />
            <span className="font-pixel text-[16px] leading-none text-green group-hover:text-[#6df09a] transition-colors hidden sm:inline">
              memory engine
            </span>
            <span className="font-mono text-xs uppercase tracking-[0.1em] text-white/50 hidden sm:inline">
              / docs
            </span>
          </a>
          <div className="flex items-center gap-5 md:gap-7">
            <a
              href="/agents.txt"
              className="font-mono text-xs uppercase tracking-[0.08em] text-white/70 hover:text-green transition-colors"
            >
              agents.txt
            </a>
            <a
              href="https://github.com/timescale/memory-engine"
              className="font-mono text-xs uppercase tracking-[0.08em] text-white/70 hover:text-green transition-colors"
            >
              github
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}
