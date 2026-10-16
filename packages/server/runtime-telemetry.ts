import { randomUUID } from "node:crypto";
import { type Meter, metrics } from "@opentelemetry/api";
import { info } from "@pydantic/logfire-node";

type Environment = Record<string, string | undefined>;

/** Run before Logfire's configure(): its env resource detector reads this once. */
export function prepareRuntimeTelemetryEnvironment(
  env: Environment = process.env,
  identity: {
    instanceId: string;
    pid: number;
    runtimeName: string;
    runtimeVersion: string;
  } = {
    instanceId: randomUUID(),
    pid: process.pid,
    runtimeName: "bun",
    runtimeVersion: Bun.version,
  },
): void {
  const supplied = env.OTEL_RESOURCE_ATTRIBUTES ?? "";
  const keys = new Set(
    supplied.split(",").map((item) => item.split("=", 1)[0]?.trim()),
  );
  const additions: Record<string, string | number | undefined> = {
    "service.instance.id": identity.instanceId,
    "process.pid": identity.pid,
    "process.runtime.name": identity.runtimeName,
    "process.runtime.version": identity.runtimeVersion,
    "k8s.pod.name":
      env.POD_NAME || (env.KUBERNETES_SERVICE_HOST ? env.HOSTNAME : undefined),
    "k8s.pod.uid": env.POD_UID,
    "k8s.namespace.name": env.NAMESPACE,
  };
  const attrs = Object.entries(additions)
    .filter(
      ([key, value]) => !keys.has(key) && value !== undefined && value !== "",
    )
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  env.OTEL_RESOURCE_ATTRIBUTES = [supplied, ...attrs].filter(Boolean).join(",");
  // NodeSDK otherwise creates implicit exporters for signals Logfire omits.
  // Explicit Logfire readers still work, but metrics:false must mean no metrics
  // even when the deployment environment previously requested an exporter.
  env.OTEL_METRICS_EXPORTER = "none";
  env.OTEL_LOGS_EXPORTER ??= "none";
}

/** Diagnostic gauges only; Kubernetes monitoring owns container measurements. */
export const RUNTIME_METRICS = {
  rss: ["memory_engine.process.memory.rss", "By"],
  heapUsed: ["memory_engine.process.memory.heap_used", "By"],
  external: ["memory_engine.process.memory.external", "By"],
  uptime: ["memory_engine.process.uptime", "s"],
  tokenizerThreads: ["memory_engine.tokenizer.threads", "{thread}"],
  tokenizerActiveJobs: ["memory_engine.tokenizer.active_jobs", "{job}"],
  tokenizerQueuedJobs: ["memory_engine.tokenizer.queued_jobs", "{job}"],
  tokenizerActiveInputBytes: ["memory_engine.tokenizer.active_input", "By"],
  tokenizerQueuedInputBytes: ["memory_engine.tokenizer.queued_input", "By"],
} as const;
type MetricKey = keyof typeof RUNTIME_METRICS;
export type MemorySample = Partial<Record<MetricKey, number>>;

export interface TokenizerStats {
  threads: number;
  activeJobs: number;
  queuedJobs: number;
  activeInputBytes: number;
  queuedInputBytes: number;
}

export interface RuntimeSamplerOptions {
  enabled?: boolean;
  metricsEnabled?: boolean;
  intervalMs?: number;
  meter?: Pick<Meter, "createObservableGauge">;
  readProcess?: () => MemorySample;
  tokenizerStats?: () => TokenizerStats;
  log?: (message: string, attributes: Record<string, number>) => void;
  /** Injected for deterministic lifecycle tests. Returns timer cancellation. */
  schedule?: (callback: () => void, intervalMs: number) => () => void;
}

/** Sparse application snapshots, with no filesystem reads or provider flushes.
 * Optional gauges use the existing SDK's native export timer and resource
 * identity; they never add point labels or create a provider/exporter. */
export function startRuntimeSampler(options: RuntimeSamplerOptions = {}): {
  stop: () => Promise<void>;
} {
  const intervalMs = options.intervalMs ?? 60_000;
  if (
    options.enabled === false ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 2 ** 31 - 1
  )
    return { stop: async () => {} };

  let stopped = false;
  let stopping: Promise<void> | undefined;
  let snapshot: MemorySample = {};
  const removals: (() => void)[] = [];
  const readProcess =
    options.readProcess ??
    (() => ({ ...process.memoryUsage(), uptime: process.uptime() }));
  const log = options.log ?? info;

  if (options.metricsEnabled === true) {
    try {
      const meter = options.meter ?? metrics.getMeter("memory-engine.runtime");
      for (const key of Object.keys(RUNTIME_METRICS) as MetricKey[]) {
        try {
          const [name, unit] = RUNTIME_METRICS[key];
          const gauge = meter.createObservableGauge(name, { unit });
          const callback: Parameters<typeof gauge.addCallback>[0] = (
            result,
          ) => {
            try {
              const value = snapshot[key];
              if (!stopped && value !== undefined) result.observe(value);
            } catch {
              /* Observation failures must not break SDK collection. */
            }
          };
          // Keep cleanup available even if registration partially succeeds.
          removals.push(() => gauge.removeCallback(callback));
          gauge.addCallback(callback);
        } catch {
          /* An unavailable instrument must not prevent other observations. */
        }
      }
    } catch {
      /* Telemetry must never prevent boot. */
    }
  }

  function tick() {
    if (stopped) return;
    const next: MemorySample = {};
    function include(key: MetricKey, value: unknown) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        next[key] = value;
    }
    try {
      const sample = readProcess();
      // Never enumerate/spread reader output: only these process fields belong
      // here, regardless of extra payload or container data returned by a reader.
      for (const key of ["rss", "heapUsed", "external", "uptime"] as const)
        include(key, sample[key]);
    } catch {
      /* Omit unavailable process measurements. */
    }
    try {
      const stats = options.tokenizerStats?.();
      if (stats) {
        include("tokenizerThreads", stats.threads);
        include("tokenizerActiveJobs", stats.activeJobs);
        include("tokenizerQueuedJobs", stats.queuedJobs);
        include("tokenizerActiveInputBytes", stats.activeInputBytes);
        include("tokenizerQueuedInputBytes", stats.queuedInputBytes);
      }
    } catch {
      /* Pool initialization/config errors must not affect boot. */
    }
    snapshot = next;
    try {
      log("Runtime memory sample", { ...snapshot });
    } catch {
      /* fail open */
    }
  }

  tick(); // Before application bootstrap, even if timer installation fails.
  let cancel = () => {};
  try {
    cancel = (
      options.schedule ??
      ((callback, interval) => {
        const timer = setInterval(callback, interval);
        try {
          timer.unref();
        } catch {
          clearInterval(timer);
          throw new Error("Unable to unref runtime sampler");
        }
        return () => clearInterval(timer);
      })
    )(tick, intervalMs);
  } catch {
    /* Timer failure must not prevent startup. */
  }

  return {
    stop() {
      if (stopping) return stopping;
      stopped = true;
      stopping = Promise.resolve();
      try {
        cancel();
      } catch {
        /* fail open */
      }
      for (const remove of removals) {
        try {
          remove();
        } catch {
          /* One failed cleanup must not skip the others. */
        }
      }
      snapshot = {};
      return stopping;
    },
  };
}
