/**
 * me serve — run a local web UI for viewing/managing memories.
 *
 * Launches a local HTTP server that:
 * - serves the embedded Vite-built React app
 * - proxies POST /rpc to the configured engine, injecting the stored API key
 *
 * Usage:
 *   me serve [--port <port>] [--host <host>] [--no-open]
 *
 * Respects the global --server flag (falls back to ME_SERVER env and
 * stored default_server, same as every other command).
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { findAvailablePort, startHttpServer } from "../serve/http-server.ts";
import { requireEngine } from "../util.ts";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 20;

export function createServeCommand(): Command {
  return new Command("serve")
    .description("run a local web UI for viewing/managing memories")
    .option(
      "--port <port>",
      `port to bind (default ${DEFAULT_PORT}; auto-increments when unspecified and default is busy)`,
    )
    .option(
      "--host <host>",
      `host to bind (default ${DEFAULT_HOST})`,
      DEFAULT_HOST,
    )
    .option("--no-open", "do not auto-open the browser")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const fmt = getOutputFormat(globalOpts);

      const creds = resolveCredentials(globalOpts.server);
      requireEngine(creds, fmt);

      const host: string = opts.host ?? DEFAULT_HOST;
      const explicitPortFlag = opts.port !== undefined;
      const requestedPort = explicitPortFlag
        ? parsePort(opts.port, fmt)
        : DEFAULT_PORT;

      // Port discovery: explicit --port is strict; default auto-increments.
      let port: number;
      if (explicitPortFlag) {
        port = requestedPort;
      } else {
        try {
          port = await findAvailablePort(
            host,
            requestedPort,
            MAX_PORT_ATTEMPTS,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (fmt === "text") {
            clack.log.error(msg);
          } else {
            output({ error: msg }, fmt, () => {});
          }
          process.exit(1);
        }
      }

      let running: ReturnType<typeof startHttpServer>;
      try {
        running = startHttpServer({
          server: creds.server,
          apiKey: creds.apiKey,
          engineSlug: creds.activeEngine ?? "",
          host,
          port,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = msg.includes("EADDRINUSE")
          ? ` (port ${port} is already in use)`
          : "";
        if (fmt === "text") {
          clack.log.error(`Failed to start server${hint}: ${msg}`);
        } else {
          output({ error: msg, port, host }, fmt, () => {});
        }
        process.exit(1);
      }

      if (fmt === "text") {
        clack.log.success(`Memory Engine UI running at ${running.url}`);
        console.log(`  Remote server: ${creds.server}`);
        if (creds.activeEngine) {
          console.log(`  Active engine: ${creds.activeEngine}`);
        }
        console.log("  Press Ctrl+C to stop.");
      } else {
        output(
          {
            url: running.url,
            host,
            port: port,
            server: creds.server,
            engine: creds.activeEngine,
          },
          fmt,
          () => {},
        );
      }

      if (opts.open !== false) {
        openBrowser(running.url).catch((err) => {
          if (fmt === "text") {
            clack.log.warn(
              `Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      }

      // Keep the process alive until Ctrl+C.
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          if (fmt === "text") {
            console.log("");
            clack.log.info("Shutting down…");
          }
          running.server.stop(true);
          resolve();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });
}

/**
 * Parse the --port flag value. Exits on invalid input.
 */
function parsePort(
  value: unknown,
  fmt: ReturnType<typeof getOutputFormat>,
): number {
  const n =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    const msg = `Invalid --port value: ${String(value)}. Expected an integer 1..65535.`;
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }
  return n;
}

/**
 * Open the given URL in the user's default browser. Best-effort; failures
 * are non-fatal (the URL is already printed to stdout).
 */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const proc = Bun.spawn(cmd, {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  // Don't await full exit — the OS handler may daemonize. A small delay
  // ensures the spawn actually dispatches before the event loop continues.
  await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 200))]);
}
