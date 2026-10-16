import { getTokenizerPoolStats } from "@memory.build/embedding";
import { configure, shutdown } from "@pydantic/logfire-node";
import { SERVER_VERSION } from "../../version";
import {
  prepareRuntimeTelemetryEnvironment,
  startRuntimeSampler,
} from "./runtime-telemetry";
import { resolveTelemetrySettings } from "./telemetry-settings";

/** Process-only setup, shared by API and standalone worker entrypoints. */
export function configureTelemetry(serviceName: string): {
  stop(): Promise<void>;
} {
  const settings = resolveTelemetrySettings();
  // Resource identity and exporter defaults must precede Logfire's env detector.
  try {
    prepareRuntimeTelemetryEnvironment();
  } catch {
    /* Telemetry must not prevent boot. */
  }
  let revision: string | undefined;
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      stderr: "ignore",
    });
    if (git.success) revision = git.stdout.toString().trim() || undefined;
  } catch {
    // Runtime images intentionally contain no git executable or repository.
  }
  revision ??= (process.env.LOGFIRE_ENVIRONMENT ?? "").includes("prod")
    ? `v${SERVER_VERSION}`
    : "main";

  try {
    configure({
      sendToLogfire: "if-token-present",
      console: process.env.LOGFIRE_CONSOLE === "true",
      serviceName,
      serviceVersion: SERVER_VERSION,
      metrics: settings.metricsEnabled ? { additionalReaders: [] } : false,
      nodeAutoInstrumentations: {
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // Bun is not V8; Kubernetes owns infrastructure monitoring. Even the
        // diagnostic profile exports only our explicitly chosen app metrics.
        "@opentelemetry/instrumentation-runtime-node": { enabled: false },
      },
      codeSource: {
        repository: "https://github.com/timescale/memory-engine",
        revision,
      },
      scrubbing:
        process.env.LOGFIRE_SCRUBBING === "false"
          ? false
          : {
              extraPatterns: [
                "content",
                "embedding",
                "access_token",
                "refresh_token",
              ],
            },
    });
  } catch {
    console.warn(
      "Telemetry configuration failed; continuing without telemetry",
    );
  }

  let sampler: ReturnType<typeof startRuntimeSampler> | undefined;
  try {
    // Start before bootstrap, including migrations and standalone worker startup.
    sampler = startRuntimeSampler({
      tokenizerStats: getTokenizerPoolStats,
      intervalMs: settings.snapshotIntervalMs,
      metricsEnabled: settings.metricsEnabled,
    });
  } catch {
    /* fail open */
  }

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        try {
          // Stop snapshots after application drain; SDK shutdown below performs
          // the only explicit flush, including the last buffered sample.
          await sampler?.stop();
        } catch {
          /* SDK shutdown must still run if the final sample fails. */
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Also bound the caller's wait: telemetry cannot hold process.exit open.
          await Promise.race([
            Promise.resolve().then(() => shutdown({ timeoutMillis: 1_000 })),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1_000);
            }),
          ]);
        } catch {
          /* best effort, including explicit exit where beforeExit never runs */
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      return stopping;
    },
  };
}
