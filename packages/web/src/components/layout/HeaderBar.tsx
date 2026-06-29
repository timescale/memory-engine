/**
 * Top header bar — 54px, logo + product name (left), space switcher + account
 * (right). Matches the "Console" handoff: a single bordered bar above the
 * search/controls row.
 */
import { AccountCluster } from "../account/AccountCluster.tsx";
import { Logo } from "../icons.tsx";

export function HeaderBar() {
  return (
    <header className="flex h-[54px] shrink-0 items-center justify-between border-b border-ink/[0.12] px-6">
      <div className="flex items-center gap-[11px]">
        <Logo />
        <span className="text-[15px] font-semibold tracking-[-0.01em]">
          Memory Engine
        </span>
        <span className="pl-0.5 font-mono text-[11px] text-ink/[0.38]">
          v2.0
        </span>
      </div>
      <AccountCluster />
    </header>
  );
}
