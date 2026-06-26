#!/usr/bin/env bun
/**
 * web:remote — one command for the web UI dev loop against a remote backend.
 *
 * Spawns two processes and wires them together:
 *   1. `me serve` — the credentialed `/rpc` proxy to the remote server (default
 *      production), on an auto-picked free port. Injects your OAuth token +
 *      active space; handles token refresh-on-401.
 *   2. the Vite dev server (`packages/web`, hot reload) with `ME_DEV_RPC_TARGET`
 *      pointed at the `me serve` port.
 *
 * Open http://localhost:5173. Both processes are torn down together on Ctrl+C
 * or if either one exits. Override the backend with `ME_SERVER=…`.
 *
 * This is the single-command form of the two-terminal flow documented in
 * DEVELOPMENT.md → "Developing the web UI (hot reload)".
 */
import { join } from "node:path";
import { findAvailablePort } from "../packages/cli/serve/http-server.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const server = process.env.ME_SERVER ?? "https://api.memory.build";
const port = await findAvailablePort("127.0.0.1", 3100, 20);
const target = `http://127.0.0.1:${port}`;

const children: Bun.Subprocess[] = [];
let shuttingDown = false;
function shutdown(code = 0): never {
  if (!shuttingDown) {
    shuttingDown = true;
    for (const child of children) child.kill();
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[web:remote] me serve → ${server}  (proxy ${target})`);

// me serve: the auth proxy. stdin ignored so Vite owns the terminal's stdin
// (its 'r'/'q'/'h' shortcuts), and so a stray keystroke can't disturb it.
children.push(
  Bun.spawn(
    [
      process.execPath,
      "run",
      "packages/cli/index.ts",
      "serve",
      "--server",
      server,
      "--port",
      String(port),
      "--no-open",
    ],
    { cwd: REPO_ROOT, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  ),
);

// Vite dev server: hot reload, proxying /rpc + /healthz to me serve.
children.push(
  Bun.spawn([process.execPath, "--filter", "@memory.build/web", "dev"], {
    cwd: REPO_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ME_DEV_RPC_TARGET: target },
  }),
);

// If either child exits (e.g. `me serve` fails because you're not logged in),
// bring the whole loop down so you don't end up with a half-running setup.
for (const child of children) child.exited.then((code) => shutdown(code ?? 0));
