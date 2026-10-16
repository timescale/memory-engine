// packages/server/index.ts
//
// Production entrypoint: configure telemetry, boot the server via startServer(),
// then install the process-level signal/error handlers that index.ts owns (and
// startServer deliberately does not). The actual bootstrap lives in start.ts so
// it can be driven in-process by tests.

import { reportError } from "@memory.build/database/telemetry";
import { getTokenizerPoolStats } from "@memory.build/embedding";
import {
  configure,
  info,
  shutdown as shutdownTelemetry,
} from "@pydantic/logfire-node";
import { SERVER_VERSION } from "../../version";
import {
  prepareRuntimeTelemetryEnvironment,
  startRuntimeSampler,
} from "./runtime-telemetry";
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

// Resource identity must be present before Logfire's env detector runs.
prepareRuntimeTelemetryEnvironment();
// Initialize telemetry before starting server
try {
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
} catch {
  console.warn("Telemetry configuration failed; continuing without telemetry");
}

const runtimeSampler = startRuntimeSampler({
  tokenizerStats: getTokenizerPoolStats,
});

async function stopTelemetry() {
  await runtimeSampler.stop();
  try {
    // Explicitly close all SDK signals even on SIGINT/process.exit(), where
    // beforeExit does not run. Export failure must not block application exit.
    await shutdownTelemetry({ timeoutMillis: 1_000 });
  } catch {
    /* best effort */
  }
}

// Boot the full stack. All env parsing / pools / migrate / worker / Bun.serve
// happen inside startServer(); see start.ts for the documented environment
// variables.
//
// Catch boot failures so the cause is reported (reportError → stderr + logfire;
// see ./telemetry) and we exit cleanly, rather than surfacing as a bare
// top-level rejection with no diagnosable cause.
let srv: Awaited<ReturnType<typeof startServer>>;
try {
  srv = await startServer();
} catch (error) {
  reportError("Server failed to start", error as Error);
  await stopTelemetry();
  process.exit(1);
}

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
  // Keep sampling while HTTP/worker work drains, then export the final snapshot
  // with a bounded wait (including SIGINT, which exits before SDK beforeExit).
  await stopTelemetry();
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
  void runtimeSampler.stop();
  reportError("Uncaught exception", error);
  process.exit(1);
});

info("Server ready", { url: srv.url });
