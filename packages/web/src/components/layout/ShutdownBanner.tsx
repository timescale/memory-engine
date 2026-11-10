import { HOSTED } from "../../api/bootstrap.ts";
import { shutdownBannerMessage } from "../../lib/shutdown-banner.ts";
import { useAccount } from "../account/account-context.ts";

export function ShutdownBanner({ email }: { email?: string | null }) {
  const account = useAccount();
  const resolvedEmail = email !== undefined ? email : account?.identity.email;
  const message = shutdownBannerMessage(resolvedEmail, {
    hosted: HOSTED,
    hostname: window.location.hostname,
  });
  if (!message) return null;

  return (
    <div
      role="status"
      className="shrink-0 border-b border-tiger-red/40 bg-tiger-red/15 px-6 py-2.5 text-[13px] text-ink"
    >
      {message}
    </div>
  );
}
