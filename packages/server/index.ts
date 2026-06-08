// packages/server/index.ts
//
// Production entrypoint: configure telemetry, boot the server via startServer(),
// then install the process-level signal/error handlers that index.ts owns (and
// startServer deliberately does not). The actual bootstrap lives in start.ts so
// it can be driven in-process by tests.
import { configure, info, reportError } from "@pydantic/logfire-node";
import { SERVER_VERSION } from "../../version";
import { startServer } from "./start";

// Resolve git revision for Logfire code source linking.
// Locally, use the actual commit hash for precise source-linking.
// In containers (no .git dir), use the version tag for prod or "main" for dev.
const gitRevision = (() => {
  try {
    return Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  } catch {
    const env = process.env.LOGFIRE_ENVIRONMENT ?? "";
    return env.includes("prod") ? `v${SERVER_VERSION}` : "main";
  }
})();

// Initialize telemetry before starting server
configure({
  sendToLogfire: "if-token-present",
  console: process.env.LOGFIRE_CONSOLE === "true",
  serviceName: "memory-engine",
  serviceVersion: SERVER_VERSION,
  codeSource: {
    repository: "https://github.com/timescale/memory-engine",
    revision: gitRevision,
  },
  scrubbing:
    process.env.LOGFIRE_SCRUBBING === "false"
      ? false
      : {
          extraPatterns: [
            "content", // Memory content — potentially sensitive user data
            "embedding", // Vector embeddings — large, not useful in traces
            "access_token",
            "refresh_token",
          ],
        },
});

// Boot the full stack. All env parsing / pools / migrate / worker / Bun.serve
// happen inside startServer(); see start.ts for the documented environment
// variables.
const srv = await startServer();

// =============================================================================
// Graceful Shutdown
// =============================================================================

let shutdownRequested = false;

async function shutdown() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  try {
    await srv.stop();
  } catch (error) {
    reportError("Error during shutdown", error as Error);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// =============================================================================
// Process Error Handlers
// =============================================================================

process.on("unhandledRejection", (reason) => {
  reportError("Unhandled promise rejection", reason as Error);
});

process.on("uncaughtException", (error) => {
  reportError("Uncaught exception", error);
  process.exit(1);
});

info("Server ready", { url: srv.url });
