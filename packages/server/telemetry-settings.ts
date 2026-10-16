/** Application telemetry is trace-first; Kubernetes/Prometheus owns infrastructure metrics. */
export interface TelemetrySettings {
  profile: "lean" | "diagnostic";
  metricsEnabled: boolean;
  snapshotIntervalMs: number;
}

/** Unknown profiles fail lean, never accidentally enabling a costly metrics pipeline. */
export function resolveTelemetrySettings(
  env: Record<string, string | undefined> = process.env,
): TelemetrySettings {
  const profile =
    env.LOGFIRE_TELEMETRY_PROFILE === "diagnostic" ? "diagnostic" : "lean";
  const fallback = profile === "diagnostic" ? 10_000 : 60_000;
  const raw = env.LOGFIRE_RUNTIME_SAMPLE_INTERVAL_MS;
  const interval = raw?.trim() ? Number(raw) : fallback;
  return {
    profile,
    metricsEnabled: profile === "diagnostic",
    snapshotIntervalMs:
      Number.isSafeInteger(interval) && interval > 0 && interval <= 2 ** 31 - 1
        ? Math.max(10_000, interval)
        : fallback,
  };
}
