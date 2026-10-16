import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { type Meter, metrics } from "@opentelemetry/api";
import { forceFlush, info } from "@pydantic/logfire-node";

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
  env.OTEL_METRIC_EXPORT_INTERVAL ??= "10000";
  // NodeSDK 0.223 otherwise creates localhost OTLP exporters for signals that
  // Logfire does not configure (no-token logs, or metrics:false). Logfire's
  // explicit readers/processors still take precedence when export is enabled.
  env.OTEL_LOGS_EXPORTER ??= "none";
  env.OTEL_METRICS_EXPORTER ??= "none";
}

export type MemorySample = Partial<Record<MetricKey, number>>;
export const RUNTIME_METRICS = {
  rss: ["memory_engine.process.memory.rss", "By"],
  heapUsed: ["memory_engine.process.memory.heap_used", "By"],
  heapTotal: ["memory_engine.process.memory.heap_total", "By"],
  external: ["memory_engine.process.memory.external", "By"],
  arrayBuffers: ["memory_engine.process.memory.array_buffers", "By"],
  uptime: ["memory_engine.process.uptime", "s"],
  cgroupUsage: ["memory_engine.cgroup.memory.usage", "By"],
  cgroupLimit: ["memory_engine.cgroup.memory.limit", "By"],
  cgroupPeak: ["memory_engine.cgroup.memory.peak", "By"],
  // v2 only: minimum finite memory.max across the visible leaf and ancestors.
  // Usage/events belong to that limiting cgroup (possibly shared with siblings),
  // NOT the leaf. This does not capture every source of memory pressure.
  cgroupEffectiveLimit: ["memory_engine.cgroup.memory.effective_limit", "By"],
  cgroupLimitingUsage: ["memory_engine.cgroup.memory.limiting.usage", "By"],
  cgroupLimitingOom: [
    "memory_engine.cgroup.memory.limiting.events.oom",
    "{event}",
  ],
  cgroupLimitingOomKill: [
    "memory_engine.cgroup.memory.limiting.events.oom_kill",
    "{event}",
  ],
  // Cumulative kernel counters exposed as gauges: absolute values, not deltas.
  cgroupOom: ["memory_engine.cgroup.memory.events.oom", "{event}"],
  cgroupOomKill: ["memory_engine.cgroup.memory.events.oom_kill", "{event}"],
  tokenizerThreads: ["memory_engine.tokenizer.threads", "{thread}"],
  tokenizerActiveJobs: ["memory_engine.tokenizer.active_jobs", "{job}"],
  tokenizerQueuedJobs: ["memory_engine.tokenizer.queued_jobs", "{job}"],
  tokenizerActiveInputBytes: ["memory_engine.tokenizer.active_input", "By"],
  tokenizerQueuedInputBytes: ["memory_engine.tokenizer.queued_input", "By"],
} as const;
type MetricKey = keyof typeof RUNTIME_METRICS;

export type TextReader = (
  path: string,
  signal?: AbortSignal,
) => Promise<string>;
const readText: TextReader = (path, signal) =>
  readFile(path, { encoding: "utf8", signal });

function nonnegativeInteger(text: string | undefined): number | undefined {
  if (!text || !/^\d+$/.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function fields(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((pair) => pair.length === 2),
  );
}

function unescapeMount(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

type CgroupLocation = {
  version: 1 | 2;
  directory: string;
  mountpoint: string;
};

/** Resolve membership relative to the mount root (including cgroup namespaces). */
export function discoverCgroups(
  cgroup: string,
  mountinfo: string,
): CgroupLocation[] {
  const locations: CgroupLocation[] = [];
  for (const membership of cgroup.trim().split("\n")) {
    const match = membership.match(/^(\d+):([^:]*):(\/.*)$/);
    if (!match) continue;
    const version =
      match[2] === ""
        ? 2
        : match[2]?.split(",").includes("memory")
          ? 1
          : undefined;
    if (!version) continue;
    const member = posix.normalize(match[3] ?? "/");
    for (const mount of mountinfo.trim().split("\n")) {
      const [left, right] = mount.split(" - ");
      const parts = left?.split(" ");
      const fs = right?.split(" ");
      if (!parts?.[3] || !parts[4] || !fs) continue;
      if (
        version === 2
          ? fs[0] !== "cgroup2"
          : fs[0] !== "cgroup" ||
            !fs.slice(1).join(",").split(",").includes("memory")
      )
        continue;
      const root = posix.normalize(unescapeMount(parts[3]));
      const mountpoint = posix.normalize(unescapeMount(parts[4]));
      // A private cgroup namespace reports / even when mountinfo has a host root.
      const relative =
        member === "/"
          ? ""
          : root === "/"
            ? member.slice(1)
            : member === root
              ? ""
              : member.startsWith(`${root}/`)
                ? member.slice(root.length + 1)
                : undefined;
      if (relative !== undefined)
        locations.push({
          version,
          directory: posix.join(mountpoint, relative),
          mountpoint,
        });
    }
  }
  return locations.sort((a, b) => b.version - a.version);
}

/** Linux files contain bytes, never kB. Unavailable/unlimited values are omitted. */
export function createCgroupReader(
  reader: TextReader = readText,
  platform: string = process.platform,
): (signal?: AbortSignal) => Promise<MemorySample> {
  return async (signal) => {
    if (platform !== "linux" || signal?.aborted) return {};
    const safeRead = async (path: string) => {
      try {
        return await reader(path, signal);
      } catch {
        return undefined;
      }
    };
    const [membership, mounts] = await Promise.all([
      safeRead("/proc/self/cgroup"),
      safeRead("/proc/self/mountinfo"),
    ]);
    const discovered =
      membership && mounts ? discoverCgroups(membership, mounts) : [];
    // Sane fallback for container images without proc metadata: these must be
    // cgroup mounts at their conventional container root, NOT process RSS.
    const locations: CgroupLocation[] = discovered.length
      ? discovered
      : [
          {
            version: 2,
            directory: "/sys/fs/cgroup",
            mountpoint: "/sys/fs/cgroup",
          },
          {
            version: 1,
            directory: "/sys/fs/cgroup/memory",
            mountpoint: "/sys/fs/cgroup/memory",
          },
        ];
    for (const { version, directory, mountpoint } of locations) {
      if (signal?.aborted) return {};
      const names =
        version === 2
          ? ["memory.current", "memory.max", "memory.peak", "memory.events"]
          : [
              "memory.usage_in_bytes",
              "memory.limit_in_bytes",
              "memory.max_usage_in_bytes",
              "memory.oom_control",
            ];
      const [usage, limit, peak, events] = await Promise.all(
        names.map((name) => safeRead(posix.join(directory, name))),
      );
      if ([usage, limit, peak, events].every((value) => value === undefined))
        continue;
      const result: MemorySample = {};
      const values: MemorySample = {
        cgroupUsage: nonnegativeInteger(usage),
        cgroupLimit: nonnegativeInteger(limit),
        cgroupPeak: nonnegativeInteger(peak),
      };
      // v1 uses a PAGE-aligned LONG_MAX sentinel; values >= 2^60 are unlimited.
      if (values.cgroupLimit !== undefined && values.cgroupLimit >= 2 ** 60)
        delete values.cgroupLimit;
      if (events) {
        const parsed = fields(events);
        // v1 under_oom is a boolean, not an OOM event count. Never conflate them.
        values.cgroupOom =
          version === 2 ? nonnegativeInteger(parsed.oom) : undefined;
        values.cgroupOomKill = nonnegativeInteger(parsed.oom_kill);
      }
      if (version === 2) {
        // Include the visible mount root, never its parent. Hidden host ancestors
        // and v1 inheritance are outside this reader's scope. Ties prefer leaf.
        let limitingDirectory: string | undefined;
        let effectiveLimit: number | undefined;
        for (let current = directory; ; current = posix.dirname(current)) {
          if (signal?.aborted) return {};
          const candidate = nonnegativeInteger(
            current === directory
              ? limit
              : await safeRead(posix.join(current, "memory.max")),
          );
          if (
            candidate !== undefined &&
            (effectiveLimit === undefined || candidate < effectiveLimit)
          ) {
            effectiveLimit = candidate;
            limitingDirectory = current;
          }
          if (current === mountpoint || current === posix.dirname(current))
            break;
        }
        if (limitingDirectory !== undefined) {
          const [limitingUsage, limitingEvents] =
            limitingDirectory === directory
              ? [usage, events]
              : await Promise.all([
                  safeRead(posix.join(limitingDirectory, "memory.current")),
                  safeRead(posix.join(limitingDirectory, "memory.events")),
                ]);
          const parsed = fields(limitingEvents ?? "");
          values.cgroupEffectiveLimit = effectiveLimit;
          values.cgroupLimitingUsage = nonnegativeInteger(limitingUsage);
          values.cgroupLimitingOom = nonnegativeInteger(parsed.oom);
          values.cgroupLimitingOomKill = nonnegativeInteger(parsed.oom_kill);
        }
      }
      for (const [key, value] of Object.entries(values))
        if (value !== undefined) result[key as MetricKey] = value;
      return result;
    }
    return {};
  };
}

export interface TokenizerStats {
  threads: number;
  activeJobs: number;
  queuedJobs: number;
  activeInputBytes: number;
  queuedInputBytes: number;
}

export interface RuntimeSamplerOptions {
  enabled?: boolean;
  intervalMs?: number;
  meter?: Pick<Meter, "createObservableGauge">;
  readProcess?: () => MemorySample;
  readCgroup?: (signal: AbortSignal) => Promise<MemorySample>;
  tokenizerStats?: () => TokenizerStats;
  log?: (message: string, attributes: Record<string, number>) => void;
  /** Injected for deterministic lifecycle tests. */
  schedule?: (callback: () => void, intervalMs: number) => () => void;
  flush?: () => Promise<void>;
  /** Supplementary provider forceFlush cadence, not the SDK's 60s reader timer.
   * Resolution is one sample interval; smaller values clamp to intervalMs and
   * invalid/nonpositive values fall back to max(10s, intervalMs). */
  exportIntervalMs?: number;
  /** Total final sample/export budget; hung readers/exporters cannot block exit. */
  shutdownTimeoutMs?: number;
  now?: () => number;
}

/** No dynamic metric labels; pod/process identity lives on the OTel resource. */
export function startRuntimeSampler(options: RuntimeSamplerOptions = {}): {
  stop: () => Promise<void>;
} {
  const intervalMs = options.intervalMs ?? 10_000;
  const requestedExportInterval =
    options.exportIntervalMs ??
    Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 10_000);
  const exportIntervalMs = Math.max(
    intervalMs,
    Number.isFinite(requestedExportInterval) && requestedExportInterval > 0
      ? requestedExportInterval
      : 10_000,
  );
  const shutdownTimeoutMs =
    Number.isFinite(options.shutdownTimeoutMs) &&
    (options.shutdownTimeoutMs ?? 0) > 0
      ? Math.min(options.shutdownTimeoutMs ?? 1_000, 2 ** 31 - 1)
      : 1_000;
  if (
    options.enabled === false ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 2 ** 31 - 1
  )
    return { stop: async () => {} };
  let stopped = false;
  let finalized = false;
  let stopping: Promise<void> | undefined;
  let snapshot: MemorySample = {};
  let pending: Promise<void> | undefined;
  let pendingFlush: Promise<void> | undefined;
  const abort = new AbortController();
  const removals: (() => void)[] = [];
  const now = options.now ?? Date.now;
  let lastExport = now();
  const log = options.log ?? info;
  const cgroup = options.readCgroup ?? createCgroupReader();
  const readProcess =
    options.readProcess ??
    (() => ({ ...process.memoryUsage(), uptime: process.uptime() }));
  // Logfire 0.18 / OTel 2.12's default reader still has a fixed 60s timer.
  // The public SDK flush reaches its registered readers AND pending spans/logs,
  // including additional readers in no-token configurations (now safe to flush).
  // Never create a second provider/exporter or probe private provider methods.
  const flush = options.flush ?? (() => forceFlush());
  try {
    const meter = options.meter ?? metrics.getMeter("memory-engine.runtime");
    for (const [key, [name, unit]] of Object.entries(RUNTIME_METRICS)) {
      const gauge = meter.createObservableGauge(name, { unit });
      const callback: Parameters<typeof gauge.addCallback>[0] = (result) => {
        const value = snapshot[key as MetricKey];
        if (value !== undefined) result.observe(value);
      };
      gauge.addCallback(callback);
      removals.push(() => gauge.removeCallback(callback));
    }
  } catch {
    /* Telemetry must never prevent boot. */
  }

  function localSample(): MemorySample {
    const next: MemorySample = {};
    try {
      Object.assign(next, readProcess());
    } catch {
      /* omit unavailable */
    }
    try {
      const stats = options.tokenizerStats?.();
      if (stats)
        Object.assign(next, {
          tokenizerThreads: stats.threads,
          tokenizerActiveJobs: stats.activeJobs,
          tokenizerQueuedJobs: stats.queuedJobs,
          tokenizerActiveInputBytes: stats.activeInputBytes,
          tokenizerQueuedInputBytes: stats.queuedInputBytes,
        });
    } catch {
      /* Pool initialization/config errors must not affect boot. */
    }
    return next;
  }

  function updateSnapshot(next: MemorySample) {
    // Explicit allowlist prevents injected readers accidentally logging data.
    snapshot = {};
    for (const key of Object.keys(RUNTIME_METRICS) as MetricKey[]) {
      const value = next[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        snapshot[key] = value;
    }
  }

  async function sample() {
    const next = localSample();
    try {
      Object.assign(next, await cgroup(abort.signal));
    } catch {
      /* omit unavailable */
    }
    if (finalized) return;
    updateSnapshot(next);
    if (stopped) return;
    try {
      log("Runtime memory sample", { ...snapshot });
    } catch {
      /* fail open */
    }
    if (
      Number.isFinite(exportIntervalMs) &&
      exportIntervalMs > 0 &&
      !pendingFlush &&
      now() - lastExport >= exportIntervalMs
    ) {
      lastExport = now();
      // Exporter latency must not hold up memory samples/logs. One flush at a
      // time, with errors contained and the existing SDK export timeout intact.
      pendingFlush = Promise.resolve()
        .then(flush)
        .catch(() => {})
        .finally(() => {
          pendingFlush = undefined;
        });
    }
  }
  function tick() {
    if (stopped || pending) return;
    pending = sample()
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      });
  }
  let cancel = () => {};
  try {
    cancel = (
      options.schedule ??
      ((callback, interval) => {
        const timer = setInterval(callback, interval);
        timer.unref();
        return () => clearInterval(timer);
      })
    )(tick, intervalMs);
    tick(); // Before startServer, including long boot migrations.
  } catch {
    /* Timer failure must not prevent startup. */
  }
  return {
    stop() {
      if (stopping) return stopping;
      stopped = true;
      try {
        cancel();
      } catch {
        /* fail open */
      }
      abort.abort();
      stopping = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await pending;
              if (finalized) return;
              // Capture post-drain process/pool values, retaining the last cgroup
              // sample. Even stop-before-first-tick exports before callbacks go.
              updateSnapshot({ ...snapshot, ...localSample() });
              await pendingFlush;
              if (!finalized)
                await Promise.resolve()
                  .then(flush)
                  .catch(() => {});
            })(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, shutdownTimeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          finalized = true;
          snapshot = {};
          for (const remove of removals) {
            try {
              remove();
            } catch {
              /* fail open */
            }
          }
        }
      })();
      return stopping;
    },
  };
}
