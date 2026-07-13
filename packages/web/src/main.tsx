/**
 * Web UI entry point — mounts the React app into #root.
 *
 * Wraps the app in a single `QueryClientProvider` so all RPC calls share a
 * cache. Defaults favor freshness over staleness: a 5s `staleTime` avoids
 * hammering the engine on quick re-renders but picks up external mutations
 * relatively quickly.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HOSTED } from "./api/bootstrap.ts";
import { App } from "./app.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { LocalAccountGate } from "./components/account/LocalAccountGate.tsx";
import { DeviceVerificationPage } from "./components/DeviceVerificationPage.tsx";
import { InviteLandingPage } from "./components/InviteLandingPage.tsx";
import { LoginPage } from "./components/LoginPage.tsx";
import "./styles.css";

// The OAuth-provider login page (`me login`'s authorize flow redirects here).
// Only the hosted API server serves it (it owns the better-auth `/api/v1/auth/*`
// routes the page calls); under local `me serve` there is no auth backend, so a
// stray /login must fall through to the SPA rather than render a page whose
// sign-in calls would 404.
const isLoginPage = HOSTED && window.location.pathname === "/login";

// Device Authorization Grant verification page (`me login --device` shows this
// URL). Hosted-only for the same reason as /login — it calls the better-auth
// device endpoints, which only the API server serves.
const isDevicePage = HOSTED && window.location.pathname === "/device";

// Magic-link redeem landing (`/invite/<token>`). Hosted-only: it signs the
// visitor in (cookie session) and redeems against the user RPC. Under local
// `me serve` there's no such auth backend, so it falls through to the SPA.
function readInviteToken(): string | null {
  if (!HOSTED || !window.location.pathname.startsWith("/invite/")) return null;
  const raw = window.location.pathname.slice("/invite/".length).split("/")[0];
  if (!raw) return null;
  try {
    // The token is untrusted URL input; a malformed %-escape would otherwise
    // throw and crash the app. Fall through to the SPA on bad input.
    return decodeURIComponent(raw) || null;
  } catch {
    return null;
  }
}
const inviteToken = readInviteToken();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isLoginPage ? (
        <LoginPage />
      ) : isDevicePage ? (
        <DeviceVerificationPage />
      ) : inviteToken ? (
        <InviteLandingPage token={inviteToken} />
      ) : HOSTED ? (
        <AuthGate>
          <App />
        </AuthGate>
      ) : (
        <LocalAccountGate>
          <App />
        </LocalAccountGate>
      )}
    </QueryClientProvider>
  </StrictMode>,
);
