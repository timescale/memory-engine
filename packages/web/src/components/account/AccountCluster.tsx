/**
 * Header right-cluster: space switcher + signed-in account + sign out.
 *
 * Reads the account context; renders nothing in local mode (no context), where
 * there is no signed-in user or switchable space.
 */
import { type AccountSpace, useAccount } from "./account-context.ts";
import { InvitationsButton } from "./Invitations.tsx";

export function AccountCluster() {
  const account = useAccount();
  if (!account) return null;

  return (
    <div className="flex items-center gap-4 font-mono text-[12px]">
      <InvitationsButton />
      <span className="text-ink/50">space</span>
      <SpaceSwitcher
        spaces={account.spaces}
        space={account.space}
        onChoose={account.onChooseSpace}
      />
      <span className="hidden text-ink/50 sm:inline">
        {account.identity.email}
      </span>
      {!account.local && (
        <button
          type="button"
          onClick={account.onLogout}
          className="text-ink/50 hover:text-ink hover:underline"
        >
          Sign out
        </button>
      )}
    </div>
  );
}

/**
 * The "default ▾" pill. A bordered pill displaying the active space name with
 * a transparent native <select> overlaid on top for accessible switching.
 */
function SpaceSwitcher({
  spaces,
  space,
  onChoose,
}: {
  spaces: AccountSpace[];
  space: string;
  onChoose: (slug: string) => void;
}) {
  const current = spaces.find((s) => s.slug === space);
  const singleSpace = spaces.length <= 1;

  return (
    <div className="relative inline-flex items-center rounded-md border border-ink/[0.16] py-[5px] pl-2.5 pr-7 transition-colors hover:border-ink">
      <span className="max-w-[140px] truncate">{current?.name ?? space}</span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 text-ink/50"
      >
        &#9662;
      </span>
      {!singleSpace && (
        <select
          value={space}
          onChange={(e) => onChoose(e.target.value)}
          aria-label="Switch space"
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {spaces.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
