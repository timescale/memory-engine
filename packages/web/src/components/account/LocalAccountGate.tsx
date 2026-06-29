/**
 * Local-mode account provider (`me serve` / `web:remote`).
 *
 * Unlike the hosted `AuthGate`, this never gates access — `me serve` already
 * supplies credentials + a bound space for `/rpc`, so the app must render
 * regardless. It best-effort fetches the signed-in identity + the spaces the
 * user can reach (via the user RPC the proxy now forwards) and the bound space
 * (`/api/serve-context`), then provides the header's account cluster.
 *
 * It blocks briefly on that fetch so the chosen space is set before the app's
 * queries fire (avoiding a flash of the wrong space), with a timeout fallback
 * so a missing/slow backend never wedges the UI. On failure — e.g. the CLI
 * isn't logged in — it renders the app with no cluster (the proxy still answers
 * `/rpc` with its own creds + bound space).
 *
 * Sign-out is intentionally absent in local mode (the CLI owns the session);
 * the space switcher works because the proxy honors a browser-sent space.
 */
import { type ReactNode, useEffect, useState } from "react";
import { memoryClient, userClient } from "../../api/client.ts";
import { type AccountInfo, AccountProvider } from "./account-context.ts";

const SPACE_STORAGE_KEY = "me.space";
const SERVE_CONTEXT_PATH = "/api/serve-context";
const FETCH_TIMEOUT_MS = 3000;

export function LocalAccountGate({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReady(true);
    };
    const timer = setTimeout(markReady, FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const [identity, { spaces }, activeSpace] = await Promise.all([
          userClient.whoami(),
          userClient.space.list(),
          fetchBoundSpace(),
        ]);
        if (cancelled || spaces.length === 0) return;

        const saved = localStorage.getItem(SPACE_STORAGE_KEY);
        const chosen =
          spaces.find((s) => s.slug === saved)?.slug ??
          spaces.find((s) => s.slug === activeSpace)?.slug ??
          spaces[0]?.slug;
        if (!chosen) return;

        // Set the space before the app renders so its first queries carry the
        // right X-Me-Space (the proxy honors it).
        memoryClient.setSpace(chosen);
        setAccount({
          identity: {
            email: identity.email ?? identity.name,
            name: identity.name,
          },
          spaces,
          space: chosen,
          onChooseSpace: (slug) => {
            localStorage.setItem(SPACE_STORAGE_KEY, slug);
            memoryClient.setSpace(slug);
            // Reload so the app re-mounts cleanly against the chosen space.
            window.location.reload();
          },
          onLogout: () => {},
          local: true,
        });
      } catch {
        // Not signed in via the CLI, or the proxy can't reach the backend —
        // render the app without the cluster.
      } finally {
        clearTimeout(timer);
        markReady();
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-ink/50">Loading…</p>
      </div>
    );
  }

  return <AccountProvider value={account}>{children}</AccountProvider>;
}

/** The space `me serve` is bound to, exposed by its `/api/serve-context`. */
async function fetchBoundSpace(): Promise<string | null> {
  try {
    const res = await fetch(SERVE_CONTEXT_PATH, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { space?: string };
    return data.space ?? null;
  } catch {
    return null;
  }
}
