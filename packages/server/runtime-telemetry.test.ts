import { describe, expect, spyOn, test } from "bun:test";
import type {
  Meter,
  ObservableCallback,
  ObservableGauge,
} from "@opentelemetry/api";
import {
  type MemorySample,
  prepareRuntimeTelemetryEnvironment,
  RUNTIME_METRICS,
  type RuntimeSamplerOptions,
  startRuntimeSampler,
} from "./runtime-telemetry";

const identity = {
  instanceId: "instance-1",
  pid: 123,
  runtimeName: "bun",
  runtimeVersion: "1.3.13",
};
const tokenizerStats = () => ({
  threads: 2,
  activeJobs: 1,
  queuedJobs: 3,
  activeInputBytes: 40,
  queuedInputBytes: 50,
});
const snapshot = {
  rss: 123,
  heapUsed: 45,
  external: 6,
  uptime: 7.5,
  tokenizerThreads: 2,
  tokenizerActiveJobs: 1,
  tokenizerQueuedJobs: 3,
  tokenizerActiveInputBytes: 40,
  tokenizerQueuedInputBytes: 50,
};

function harness(options: RuntimeSamplerOptions = {}) {
  const logs: { message: string; attributes: Record<string, number> }[] = [];
  let tick = () => {};
  let interval: number | undefined;
  let cancellations = 0;
  const sampler = startRuntimeSampler({
    readProcess: () => ({ rss: 123, heapUsed: 45, external: 6, uptime: 7.5 }),
    tokenizerStats,
    log: (message, attributes) => logs.push({ message, attributes }),
    schedule: (callback, milliseconds) => {
      tick = callback;
      interval = milliseconds;
      return () => {
        cancellations++;
      };
    },
    ...options,
  });
  return {
    sampler,
    logs,
    tick: () => tick(),
    get interval() {
      return interval;
    },
    get cancellations() {
      return cancellations;
    },
  };
}

function capturedMeter() {
  const callbacks = new Map<string, Set<ObservableCallback>>();
  const units = new Map<string, string | undefined>();
  let removals = 0;
  const meter = {
    createObservableGauge(name: string, options?: { unit?: string }) {
      const entries = new Set<ObservableCallback>();
      callbacks.set(name, entries);
      units.set(name, options?.unit);
      return {
        addCallback(callback: ObservableCallback) {
          entries.add(callback);
        },
        removeCallback(callback: ObservableCallback) {
          removals++;
          entries.delete(callback);
        },
      } as ObservableGauge;
    },
  } satisfies Pick<Meter, "createObservableGauge">;
  function collect() {
    const values: Record<string, { value: number; attributes: unknown }[]> = {};
    for (const [name, entries] of callbacks)
      for (const callback of entries)
        callback({
          observe(value, attributes) {
            const observations = values[name] ?? [];
            observations.push({ value, attributes });
            values[name] = observations;
          },
        });
    return values;
  }
  return {
    meter,
    units,
    collect,
    callbacks,
    get removals() {
      return removals;
    },
  };
}

describe("runtime resource identity and exporter policy", () => {
  test("adds process/pod identity without overwriting supplied attributes", () => {
    const env = {
      OTEL_RESOURCE_ATTRIBUTES:
        "service.name=custom,service.instance.id=operator,process.pid=99,k8s.pod.name=explicit",
      POD_NAME: "api pod",
      POD_UID: "pod-uid",
      NAMESPACE: "namespace",
    };
    prepareRuntimeTelemetryEnvironment(env, identity);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "service.name=custom,service.instance.id=operator,process.pid=99,k8s.pod.name=explicit,process.runtime.name=bun,process.runtime.version=1.3.13,k8s.pod.uid=pod-uid,k8s.namespace.name=namespace",
    );
    const prepared = env.OTEL_RESOURCE_ATTRIBUTES;
    prepareRuntimeTelemetryEnvironment(env, identity);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(prepared);
  });

  test("generates unique per-start identity and current runtime metadata", () => {
    const first: Record<string, string | undefined> = {};
    const second: Record<string, string | undefined> = {};
    prepareRuntimeTelemetryEnvironment(first);
    prepareRuntimeTelemetryEnvironment(second);
    const attributes = Object.fromEntries(
      (first.OTEL_RESOURCE_ATTRIBUTES ?? "")
        .split(",")
        .map((p) => p.split("=")),
    );
    expect(attributes["service.instance.id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.OTEL_RESOURCE_ATTRIBUTES).not.toBe(
      second.OTEL_RESOURCE_ATTRIBUTES,
    );
    expect(attributes["process.pid"]).toBe(String(process.pid));
    expect(attributes["process.runtime.name"]).toBe("bun");
    expect(attributes["process.runtime.version"]).toBe(Bun.version);
    expect(first.OTEL_RESOURCE_ATTRIBUTES).not.toContain("k8s.");
  });

  test("encodes pod attributes and only falls back to hostname in Kubernetes", () => {
    const env: Record<string, string | undefined> = {
      POD_NAME: "api pod",
      HOSTNAME: "host",
      KUBERNETES_SERVICE_HOST: "cluster",
    };
    prepareRuntimeTelemetryEnvironment(env, identity);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("k8s.pod.name=api%20pod");
    delete env.OTEL_RESOURCE_ATTRIBUTES;
    delete env.POD_NAME;
    prepareRuntimeTelemetryEnvironment(env, identity);
    expect(env.OTEL_RESOURCE_ATTRIBUTES ?? "").toContain("k8s.pod.name=host");
    delete env.OTEL_RESOURCE_ATTRIBUTES;
    delete env.KUBERNETES_SERVICE_HOST;
    prepareRuntimeTelemetryEnvironment(env, identity);
    expect(env.OTEL_RESOURCE_ATTRIBUTES ?? "").not.toContain("k8s.pod.name");
  });

  test("enforces metrics none, defaults logs none, preserves explicit logs", () => {
    for (const supplied of [undefined, "otlp", "console", "none"]) {
      const env: Record<string, string | undefined> = {
        OTEL_METRICS_EXPORTER: supplied,
        OTEL_LOGS_EXPORTER: supplied,
      };
      prepareRuntimeTelemetryEnvironment(env, identity);
      expect(env.OTEL_METRICS_EXPORTER).toBe("none");
      expect(env.OTEL_LOGS_EXPORTER).toBe(supplied ?? "none");
      expect(env).not.toHaveProperty("OTEL_METRIC_EXPORT_INTERVAL");
    }
  });

  test("never reads or sets the SDK-ignored metric interval", async () => {
    const env: Record<string, string | undefined> = {};
    Object.defineProperty(env, "OTEL_METRIC_EXPORT_INTERVAL", {
      get() {
        throw new Error("must not read");
      },
      set() {
        throw new Error("must not set");
      },
    });
    expect(() =>
      prepareRuntimeTelemetryEnvironment(env, identity),
    ).not.toThrow();
    const sample = harness();
    expect(sample.interval).toBe(60_000);
    await sample.sampler.stop();
  });
});

describe("sparse runtime sampler", () => {
  test("logs once at startup and on each 60-second tick; stop only cleans up", async () => {
    const sample = harness();
    expect(sample.interval).toBe(60_000);
    expect(sample.logs).toEqual([
      { message: "Runtime memory sample", attributes: snapshot },
    ]);
    sample.tick();
    sample.tick();
    expect(sample.logs).toHaveLength(3);
    const first = sample.sampler.stop();
    expect(sample.sampler.stop()).toBe(first);
    await first;
    sample.tick();
    expect(sample.logs).toHaveLength(3);
    expect(sample.cancellations).toBe(1);
  });

  test("uses the supplied sample cadence without creating gauges by default", async () => {
    const meter = capturedMeter();
    const sample = harness({ intervalMs: 123_456, meter: meter.meter });
    expect(sample.interval).toBe(123_456);
    expect(meter.callbacks.size).toBe(0);
    await sample.sampler.stop();
    expect(meter.removals).toBe(0);
  });

  test("logs only the numeric allowlist and omits invalid values and arbitrary payloads", async () => {
    const sample = harness({
      readProcess: () => ({
        rss: 0,
        heapUsed: Number.NaN,
        external: -1,
        uptime: Number.POSITIVE_INFINITY,
        heapTotal: 999,
        arrayBuffers: 888,
        cgroupUsage: 777,
        cgroupLimit: 666,
        payload: "secret",
        tokenizerThreads: 999,
      }),
      tokenizerStats: () => ({
        threads: 0,
        activeJobs: Number.NaN,
        queuedJobs: -1,
        activeInputBytes: Number.POSITIVE_INFINITY,
        queuedInputBytes: 10,
        payload: "secret",
      }),
    });
    expect(sample.logs[0]?.attributes).toEqual({
      rss: 0,
      tokenizerThreads: 0,
      tokenizerQueuedInputBytes: 10,
    });
    await sample.sampler.stop();
  });

  test("omits nonnumeric values at runtime, including numeric strings", async () => {
    const sample = harness({
      readProcess: () =>
        ({
          rss: "123",
          heapUsed: null,
          external: true,
        }) as unknown as MemorySample,
      tokenizerStats: undefined,
    });
    expect(sample.logs[0]?.attributes).toEqual({});
    await sample.sampler.stop();
  });

  test("diagnostic gauges use the same nine keys and no point labels", async () => {
    const meter = capturedMeter();
    let rss = 123;
    const sample = harness({
      metricsEnabled: true,
      meter: meter.meter,
      readProcess: () => ({ rss, heapUsed: 45, external: 6, uptime: 7.5 }),
    });
    expect(meter.callbacks.size).toBe(9);
    const expected: ReturnType<typeof meter.collect> = {};
    for (const [key, [name, unit]] of Object.entries(RUNTIME_METRICS)) {
      expect(meter.units.get(name)).toBe(unit);
      expected[name] = [
        {
          value: snapshot[key as keyof typeof snapshot],
          attributes: undefined,
        },
      ];
    }
    expect(meter.collect()).toEqual(expected);
    rss = 456;
    sample.tick();
    expect(meter.collect()[RUNTIME_METRICS.rss[0]]).toEqual([
      { value: 456, attributes: undefined },
    ]);
    expect(sample.logs[1]?.attributes.rss).toBe(456);
    await sample.sampler.stop();
    await sample.sampler.stop();
    expect(meter.removals).toBe(9);
    expect(meter.collect()).toEqual({});
    for (const callbacks of meter.callbacks.values())
      expect(callbacks.size).toBe(0);
  });

  test("unavailable measurements replace stale gauge values instead of reporting zero", async () => {
    const meter = capturedMeter();
    let unavailable = false;
    const sample = harness({
      metricsEnabled: true,
      meter: meter.meter,
      readProcess: () => {
        if (unavailable) throw new Error("process unavailable");
        return { rss: 12 };
      },
      tokenizerStats: () => {
        if (unavailable) throw new Error("pool unavailable");
        return tokenizerStats();
      },
    });
    expect(meter.collect()[RUNTIME_METRICS.rss[0]]?.[0]?.value).toBe(12);
    unavailable = true;
    sample.tick();
    expect(sample.logs[1]?.attributes).toEqual({});
    expect(meter.collect()).toEqual({});
    await sample.sampler.stop();
  });

  test("logger and timer failures do not suppress startup or shutdown", async () => {
    let logs = 0;
    const sampler = startRuntimeSampler({
      readProcess: () => {
        throw new Error("unavailable");
      },
      tokenizerStats: () => {
        throw new Error("unavailable");
      },
      log: () => {
        logs++;
        throw new Error("logger unavailable");
      },
      schedule: () => {
        throw new Error("timer unavailable");
      },
    });
    expect(logs).toBe(1);
    await sampler.stop();
    await sampler.stop();
    expect(logs).toBe(1);
  });

  test("gauge registration, observation, and cleanup failures are isolated", async () => {
    const captured = capturedMeter();
    let attempts = 0;
    let removals = 0;
    const sample = harness({
      metricsEnabled: true,
      meter: {
        createObservableGauge(name, options) {
          attempts++;
          if (attempts === 1) throw new Error("instrument unavailable");
          const gauge = captured.meter.createObservableGauge(name, options);
          const remove = gauge.removeCallback.bind(gauge);
          gauge.removeCallback = (callback) => {
            removals++;
            remove(callback);
            if (removals === 1) throw new Error("cleanup unavailable");
          };
          return gauge;
        },
      },
      schedule: () => () => {
        throw new Error("cancel unavailable");
      },
    });
    expect(attempts).toBe(9);
    expect(sample.logs).toHaveLength(1);
    for (const callbacks of captured.callbacks.values())
      for (const callback of callbacks)
        expect(() =>
          callback({
            observe() {
              throw new Error("observe unavailable");
            },
          }),
        ).not.toThrow();
    await sample.sampler.stop();
    expect(removals).toBe(8);
    expect(captured.collect()).toEqual({});
  });

  test("cleans up partially registered callbacks", async () => {
    const captured = capturedMeter();
    const sample = harness({
      metricsEnabled: true,
      meter: {
        createObservableGauge(name, options) {
          const gauge = captured.meter.createObservableGauge(name, options);
          const add = gauge.addCallback.bind(gauge);
          gauge.addCallback = (callback) => {
            add(callback);
            throw new Error("partially registered");
          };
          return gauge;
        },
      },
    });
    await sample.sampler.stop();
    expect(captured.removals).toBe(9);
    expect(captured.collect()).toEqual({});
  });

  test("disabled sampler and invalid intervals schedule nothing", async () => {
    for (const options of [
      { enabled: false },
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31].map(
        (intervalMs) => ({ intervalMs }),
      ),
    ]) {
      const sample = harness(options);
      expect(sample.interval).toBeUndefined();
      expect(sample.logs).toEqual([]);
      await sample.sampler.stop();
      await sample.sampler.stop();
    }
  });

  test("default timer is unref'd and canceled exactly once", async () => {
    const unref = spyOn(globalThis, "setInterval").mockImplementation(() => {
      return timer as unknown as ReturnType<typeof setInterval>;
    });
    let unrefs = 0;
    const timer = {
      unref: () => {
        unrefs++;
      },
    };
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(
      () => {},
    );
    try {
      const sampler = startRuntimeSampler({
        readProcess: () => ({}),
        log: () => {},
      });
      expect(unref).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(unrefs).toBe(1);
      await sampler.stop();
      await sampler.stop();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      unref.mockRestore();
      clear.mockRestore();
    }
  });

  test("has no filesystem dependency, cgroup reader, exporter, or flush path", async () => {
    const source = await Bun.file(
      new URL("./runtime-telemetry.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(
      /(?:node:fs|node:path|readFile|readCgroup|createCgroupReader|forceFlush|OTEL_METRIC_EXPORT_INTERVAL)/,
    );
    expect(Object.keys(RUNTIME_METRICS)).toEqual(Object.keys(snapshot));
    expect(Object.keys(RUNTIME_METRICS)).toHaveLength(9);
  });
});

test("real OTel in-memory collection has nine unlabeled gauges and removes observations on stop", async () => {
  // No global provider, Logfire configuration, network exporter, or external I/O.
  const { MeterProvider, MetricReader } = await import(
    "@opentelemetry/sdk-metrics"
  );
  class Reader extends MetricReader {
    protected async onForceFlush() {}
    protected async onShutdown() {}
  }
  const reader = new Reader();
  const provider = new MeterProvider({ readers: [reader] });
  const meter = provider.getMeter("runtime-test");
  const removals: ReturnType<typeof spyOn>[] = [];
  const sample = harness({
    metricsEnabled: true,
    meter: {
      createObservableGauge(name, options) {
        const gauge = meter.createObservableGauge(name, options);
        removals.push(spyOn(gauge, "removeCallback"));
        return gauge;
      },
    },
  });
  try {
    const batch = await reader.collect();
    expect(batch.errors).toEqual([]);
    const gauges = batch.resourceMetrics.scopeMetrics.flatMap(
      (scope) => scope.metrics,
    );
    expect(gauges).toHaveLength(9);
    for (const [key, [name, unit]] of Object.entries(RUNTIME_METRICS)) {
      const gauge = gauges.find((metric) => metric.descriptor.name === name);
      expect(gauge?.descriptor.unit).toBe(unit);
      expect(gauge?.dataPoints).toHaveLength(1);
      expect(gauge?.dataPoints[0]?.value).toBe(
        snapshot[key as keyof typeof snapshot],
      );
      expect(gauge?.dataPoints[0]?.attributes).toEqual({});
    }
    await sample.sampler.stop();
    expect(removals).toHaveLength(9);
    for (const remove of removals) expect(remove).toHaveBeenCalledTimes(1);
    // Cumulative readers can retain their last points after callback removal;
    // cleanup stops observations, not the SDK's own aggregation state.
    expect((await reader.collect()).errors).toEqual([]);
  } finally {
    await sample.sampler.stop();
    await provider.shutdown();
    for (const remove of removals) remove.mockRestore();
  }
});
