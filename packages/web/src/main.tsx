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
import { LoginPage } from "./components/LoginPage.tsx";
import "./styles.css";

// The OAuth-provider login page (`me login`'s authorize flow redirects here).
// It's served by the API server at /login alongside the SPA, so handle the path
// before the hosted/local app split.
const isLoginPage = window.location.pathname === "/login";

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
      ) : HOSTED ? (
        <AuthGate>
          <App />
        </AuthGate>
      ) : (
        <App />
      )}
    </QueryClientProvider>
  </StrictMode>,
);
