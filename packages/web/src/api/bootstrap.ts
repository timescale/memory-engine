/**
 * Runtime mode for the web UI.
 *
 * The hosted server injects `window.__ME_BOOTSTRAP__ = { mode: "hosted" }` into
 * index.html before the app loads. `me serve` and the Vite dev server inject
 * nothing, so the app defaults to **local** mode (talks to the `/rpc` proxy,
 * which supplies auth + the active space). In **hosted** mode the browser
 * authenticates via the httpOnly session cookie and chooses its own space.
 */
export type AppMode = "local" | "hosted";

interface Bootstrap {
  mode: AppMode;
}

const raw = (globalThis as { __ME_BOOTSTRAP__?: Partial<Bootstrap> })
  .__ME_BOOTSTRAP__;

export const APP_MODE: AppMode = raw?.mode === "hosted" ? "hosted" : "local";
export const HOSTED: boolean = APP_MODE === "hosted";
