import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import type {
  Meter,
  ObservableCallback,
  ObservableGauge,
} from "@opentelemetry/api";
import { satisfies } from "semver";
import {
  createCgroupReader,
  discoverCgroups,
  type MemorySample,
  prepareRuntimeTelemetryEnvironment,
  RUNTIME_METRICS,
  startRuntimeSampler,
  type TextReader,
} from "./runtime-telemetry";

const identity = {
  instanceId: "instance-1",
  pid: 123,
  runtimeName: "bun",
  runtimeVersion: "1.3.13",
};
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const readerFor =
  (files: Record<string, string>): TextReader =>
  async (path) => {
    if (!(path in files)) throw new Error("unavailable");
    return files[path] ?? "";
  };

function capturedMeter() {
  const callbacks = new Map<string, Set<ObservableCallback>>();
  const units = new Map<string, string | undefined>();
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
          entries.delete(callback);
        },
      } as ObservableGauge;
    },
  } satisfies Pick<Meter, "createObservableGauge">;
  function collect() {
    const values: Record<string, number> = {};
    for (const [name, entries] of callbacks)
      for (const callback of entries)
        callback({
          observe(value) {
            values[name] = value;
          },
        });
    return values;
  }
  return { meter, units, collect, callbacks };
}

test("installed Logfire OTel peers satisfy upstream ranges and share one SDK across runtime workspaces", async () => {
  async function installedPackage(name: string, base: string) {
    let directory = dirname(Bun.resolveSync(name, base));
    while (directory !== dirname(directory)) {
      const file = Bun.file(resolve(directory, "package.json"));
      if (await file.exists()) {
        const manifest = (await file.json()) as {
          name: string;
          version: string;
          peerDependencies?: Record<string, string>;
        };
        if (manifest.name === name) return { directory, manifest };
      }
      directory = dirname(directory);
    }
    throw new Error(`No installed manifest for ${name}`);
  }
  for (const workspace of [
    "database",
    "embedding",
    "engine",
    "server",
    "worker",
  ]) {
    const logfire = await installedPackage(
      "@pydantic/logfire-node",
      resolve(import.meta.dir, "..", workspace),
    );
    const api = await installedPackage("logfire", logfire.directory);
    for (const owner of [logfire, api]) {
      for (const [name, range] of Object.entries(
        owner.manifest.peerDependencies ?? {},
      )) {
        if (!name.startsWith("@opentelemetry/")) continue;
        const peer = await installedPackage(name, owner.directory);
        expect(satisfies(peer.manifest.version, range)).toBe(true);
        // The installed entrypoint, not just its version, must be shared with
        // our instruments: duplicate SDK copies can silently split providers.
        expect(Bun.resolveSync(name, owner.directory)).toBe(
          Bun.resolveSync(name, import.meta.dir),
        );
      }
    }
  }
});

test("real Logfire configure exports generated resource identity and runtime gauges (isolated, no network)", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import assert from "node:assert/strict";
    import { dirname } from "node:path";
    import { configure, shutdown } from "@pydantic/logfire-node";
    import { prepareRuntimeTelemetryEnvironment, startRuntimeSampler, RUNTIME_METRICS } from "./runtime-telemetry.ts";
    const logfireDir = dirname(Bun.resolveSync("@pydantic/logfire-node", process.cwd()));
    const sdk = await import(Bun.resolveSync("@opentelemetry/sdk-metrics", logfireDir));
    const exporter = new sdk.InMemoryMetricExporter(sdk.AggregationTemporality.CUMULATIVE);
    const reader = new sdk.PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3600000 });
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    process.env.POD_NAME = "test-pod";
    process.env.POD_UID = "test-uid";
    process.env.NAMESPACE = "test-namespace";
    prepareRuntimeTelemetryEnvironment();
    configure({ sendToLogfire: false, console: false, serviceName: "runtime-test", metrics: { additionalReaders: [reader] } });
    const sampler = startRuntimeSampler({
      readProcess: () => ({ rss: 123, heapUsed: 45 }),
      readCgroup: async () => ({ cgroupUsage: 100, cgroupEffectiveLimit: 500, cgroupLimitingUsage: 400, cgroupLimitingOom: 2 }),
      tokenizerStats: () => ({ threads: 2, activeJobs: 1, queuedJobs: 3, activeInputBytes: 40, queuedInputBytes: 50 }),
      schedule: () => () => {}, log: () => {},
      // Exercise the default public Logfire flush, including its no-token
      // reader, instead of bypassing provider wiring by flushing only reader.
    });
    await sampler.stop();
    const batch = exporter.getMetrics().at(-1);
    assert.ok(batch);
    const attrs = batch.resource.attributes;
    assert.match(attrs["service.instance.id"], /^[0-9a-f-]{36}$/);
    assert.equal(String(attrs["process.pid"]), String(process.pid));
    assert.equal(attrs["process.runtime.name"], "bun");
    assert.equal(attrs["process.runtime.version"], Bun.version);
    assert.equal(attrs["service.name"], "runtime-test");
    assert.equal(attrs["k8s.pod.name"], "test-pod");
    assert.equal(attrs["k8s.pod.uid"], "test-uid");
    assert.equal(attrs["k8s.namespace.name"], "test-namespace");
    const gauges = batch.scopeMetrics.flatMap(s => s.metrics);
    for (const [key, value] of Object.entries({ rss: 123, heapUsed: 45, cgroupUsage: 100, cgroupEffectiveLimit: 500, cgroupLimitingUsage: 400, cgroupLimitingOom: 2, tokenizerQueuedInputBytes: 50 })) {
      const gauge = gauges.find(m => m.descriptor.name === RUNTIME_METRICS[key][0]);
      assert.equal(gauge.descriptor.unit, RUNTIME_METRICS[key][1]);
      assert.equal(gauge.dataPoints[0].value, value);
      assert.deepEqual(gauge.dataPoints[0].attributes, {});
    }
    await shutdown({ timeoutMillis: 1000 });
    await shutdown({ timeoutMillis: 1000 }); // idempotent; natural exit below
  `,
    ],
    {
      cwd: import.meta.dir,
      env: { ...process.env, LOGFIRE_SEND_TO_LOGFIRE: "false" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("default Logfire provider cadence, final flush and SDK shutdown export metrics and spans to loopback", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
      import assert from "node:assert/strict";
      import { metrics as otelMetrics } from "@opentelemetry/api";
      import { MeterProvider } from "@opentelemetry/sdk-metrics";
      import { configure, info, shutdown } from "@pydantic/logfire-node";
      import { prepareRuntimeTelemetryEnvironment, startRuntimeSampler } from "./runtime-telemetry.ts";
      const batches = [];
      const intervals = [];
      const realSetInterval = globalThis.setInterval;
      globalThis.setInterval = (callback, ms, ...args) => {
        intervals.push(ms);
        return realSetInterval(callback, ms, ...args);
      };
      async function until(predicate) {
        const deadline = Date.now() + 2000;
        while (!predicate()) {
          assert.ok(Date.now() < deadline, "loopback export timed out");
          await Bun.sleep(5);
        }
      }
      const collector = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
          const bytes = Buffer.from(await request.arrayBuffer());
          batches.push({ path: new URL(request.url).pathname, bytes });
          return new Response(new Uint8Array(), { headers: { "Content-Type": "application/x-protobuf" } });
        },
      });
      prepareRuntimeTelemetryEnvironment();
      configure({
        sendToLogfire: true, token: "local-test-token", console: false,
        advanced: { baseUrl: "http://127.0.0.1:" + collector.port },
      });
      globalThis.setInterval = realSetInterval;
      // Logfire's default reader does not consume the env interval even on OTel
      // 2.12. Supplementary flushes must reach that SAME provider at 10s ticks.
      assert.equal(process.env.OTEL_METRIC_EXPORT_INTERVAL, "10000");
      assert.ok(intervals.includes(60000), "default SDK reader must retain its 60s timer");
      assert.ok(otelMetrics.getMeterProvider() instanceof MeterProvider, "one shared SDK-metrics instance");
      let clock = 0, tick, samples = 0;
      const sampler = startRuntimeSampler({
        readProcess: () => ({ rss: 123456, heapUsed: 65432 }),
        readCgroup: async () => ({}),
        now: () => clock,
        schedule: (callback, interval) => {
          assert.equal(interval, 10000);
          tick = callback;
          return () => {};
        },
        log(message, attrs) { samples++; info(message, attrs); },
      });
      await until(() => samples === 1);
      assert.equal(batches.filter(b => b.path === "/v1/metrics").length, 0);
      clock = 9999; tick();
      await until(() => samples === 2);
      assert.equal(batches.filter(b => b.path === "/v1/metrics").length, 0);
      info("Before cadence flush");
      clock = 10000; tick();
      await until(() => batches.some(b => b.path === "/v1/metrics") && batches.some(b => b.path === "/v1/traces"));
      const metrics = batches.find(batch => batch.path === "/v1/metrics");
      assert.ok(metrics, "default SDK forceFlush must export on the sampling cadence, before stop");
      for (const key of ["memory_engine.process.memory.rss", "memory_engine.process.memory.heap_used", "service.instance.id", "process.runtime.version"]) {
        assert.ok(metrics.bytes.includes(Buffer.from(key)), key);
      }
      assert.ok(batches.some(b => b.path === "/v1/traces" && b.bytes.includes(Buffer.from("Before cadence flush"))));
      const exportsBeforeStop = batches.filter(b => b.path === "/v1/metrics").length;
      info("Before final sampler flush");
      await sampler.stop();
      assert.ok(batches.filter(b => b.path === "/v1/metrics").length > exportsBeforeStop, "final flush before callback removal");
      assert.ok(batches.some(b => b.path === "/v1/traces" && b.bytes.includes(Buffer.from("Before final sampler flush"))));
      info("Before SDK shutdown");
      await shutdown({ timeoutMillis: 1000 });
      assert.ok(batches.some(b => b.path === "/v1/traces" && b.bytes.includes(Buffer.from("Before SDK shutdown"))));
      await shutdown({ timeoutMillis: 1000 });
      collector.stop(true); // natural child exit proves SDK timers/listeners stop
      `,
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        LOGFIRE_TOKEN: "",
        LOGFIRE_SEND_TO_LOGFIRE: "false",
        OTEL_METRIC_EXPORT_INTERVAL: "10000",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

describe("runtime resource identity", () => {
  test("preserves all explicit attributes and export interval verbatim", () => {
    const env = {
      OTEL_RESOURCE_ATTRIBUTES:
        "custom.key=custom%2Cvalue,service.instance.id=operator,k8s.pod.name=explicit,process.pid=999",
      OTEL_METRIC_EXPORT_INTERVAL: "34567",
      POD_NAME: "pod-a",
      POD_UID: "uid-a",
      NAMESPACE: "production",
    };
    prepareRuntimeTelemetryEnvironment(env, identity);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toStartWith(
      "custom.key=custom%2Cvalue,service.instance.id=operator,k8s.pod.name=explicit,process.pid=999,",
    );
    expect(env.OTEL_RESOURCE_ATTRIBUTES).not.toContain("instance-1");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("k8s.pod.uid=uid-a");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(
      "k8s.namespace.name=production",
    );
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(
      "process.runtime.version=1.3.13",
    );
    expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBe("34567");
  });
  test("disables implicit NodeSDK exporters but preserves explicit operator choices", () => {
    const defaults: Record<string, string | undefined> = {};
    prepareRuntimeTelemetryEnvironment(defaults, identity);
    expect(defaults.OTEL_LOGS_EXPORTER).toBe("none");
    expect(defaults.OTEL_METRICS_EXPORTER).toBe("none");
    const explicit = {
      OTEL_LOGS_EXPORTER: "console",
      OTEL_METRICS_EXPORTER: "otlp",
    };
    prepareRuntimeTelemetryEnvironment(explicit, identity);
    expect(explicit.OTEL_LOGS_EXPORTER).toBe("console");
    expect(explicit.OTEL_METRICS_EXPORTER).toBe("otlp");
  });
  test("creates unique startup identity and only uses HOSTNAME in Kubernetes", () => {
    const a: Record<string, string> = { HOSTNAME: "local-machine" };
    const b: Record<string, string> = {
      HOSTNAME: "pod-host",
      KUBERNETES_SERVICE_HOST: "internal",
    };
    prepareRuntimeTelemetryEnvironment(a);
    prepareRuntimeTelemetryEnvironment(b);
    expect(a.OTEL_RESOURCE_ATTRIBUTES).not.toContain("k8s.pod.name");
    expect(b.OTEL_RESOURCE_ATTRIBUTES).toContain("k8s.pod.name=pod-host");
    const instance = (value: string | undefined) =>
      value?.split(",").find((item) => item.startsWith("service.instance.id="));
    expect(instance(a.OTEL_RESOURCE_ATTRIBUTES)).not.toBe(
      instance(b.OTEL_RESOURCE_ATTRIBUTES),
    );
    expect(a.OTEL_METRIC_EXPORT_INTERVAL).toBe("10000");
  });
  test("escapes resource values and is idempotent", () => {
    const env = { POD_NAME: "pod,one=two", OTEL_RESOURCE_ATTRIBUTES: "" };
    prepareRuntimeTelemetryEnvironment(env, identity);
    const original = env.OTEL_RESOURCE_ATTRIBUTES;
    prepareRuntimeTelemetryEnvironment(env, identity);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(original);
    expect(original).toContain("k8s.pod.name=pod%2Cone%3Dtwo");
  });
});

describe("Linux cgroup memory", () => {
  test("discovers v2 mount roots, namespace roots, and escaped mount points", () => {
    expect(
      discoverCgroups(
        "0::/tenant/pod/container",
        "1 0 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw",
      ),
    ).toEqual([
      {
        version: 2,
        directory: "/sys/fs/cgroup/pod/container",
        mountpoint: "/sys/fs/cgroup",
      },
    ]);
    expect(
      discoverCgroups(
        "0::/",
        "1 0 0:1 /tenant/pod /sys/fs/cgroup rw - cgroup2 cgroup rw",
      ),
    ).toEqual([
      { version: 2, directory: "/sys/fs/cgroup", mountpoint: "/sys/fs/cgroup" },
    ]);
    expect(
      discoverCgroups(
        "5:cpu,memory:/pod",
        "1 0 0:1 / /mounted\\040memory rw - cgroup cgroup rw,memory,cpu",
      ),
    ).toEqual([
      {
        version: 1,
        directory: "/mounted memory/pod",
        mountpoint: "/mounted memory",
      },
    ]);
    expect(discoverCgroups("broken", "broken")).toEqual([]);
    expect(
      discoverCgroups(
        "0::/other",
        "1 0 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw",
      ),
    ).toEqual([]);
  });
  test("v2 exports bytes and absolute OOM counters, not process RSS", async () => {
    const sample = await createCgroupReader(
      readerFor({
        "/proc/self/cgroup": "0::/pod",
        "/proc/self/mountinfo":
          "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
        "/sys/fs/cgroup/pod/memory.current": "123456\n",
        "/sys/fs/cgroup/pod/memory.max": "987654321\n",
        "/sys/fs/cgroup/pod/memory.peak": "234567\n",
        "/sys/fs/cgroup/pod/memory.events":
          "low 0\nhigh 0\nmax 9\noom 3\noom_kill 2\n",
      }),
      "linux",
    )();
    expect(sample).toEqual({
      cgroupUsage: 123456,
      cgroupLimit: 987654321,
      cgroupEffectiveLimit: 987654321,
      cgroupLimitingUsage: 123456,
      cgroupLimitingOom: 3,
      cgroupLimitingOomKill: 2,
      cgroupPeak: 234567,
      cgroupOom: 3,
      cgroupOomKill: 2,
    });
  });
  test("v2 unlimited leaf inherits the smallest visible ancestor; usage/events stay scoped", async () => {
    const files = {
      "/proc/self/cgroup": "0::/tenant/pod/leaf",
      "/proc/self/mountinfo": "1 0 0:1 /tenant /visible rw - cgroup2 cgroup rw",
      "/visible/pod/leaf/memory.current": "100",
      "/visible/pod/leaf/memory.max": "max",
      "/visible/pod/leaf/memory.peak": "120",
      "/visible/pod/leaf/memory.events": "oom 0\noom_kill 0",
      "/visible/pod/memory.max": "500",
      "/visible/pod/memory.current": "400",
      "/visible/pod/memory.events": "oom 3\noom_kill 2",
      "/visible/memory.max": "1000",
      "/visible/memory.current": "900",
      "/visible/memory.events": "oom 8\noom_kill 7",
      "/memory.max": "1", // Outside mount; must never be read.
    };
    const paths: string[] = [];
    const reader = createCgroupReader(async (path) => {
      paths.push(path);
      return readerFor(files)(path);
    }, "linux");
    expect(await reader()).toEqual({
      cgroupUsage: 100,
      cgroupPeak: 120,
      cgroupOom: 0,
      cgroupOomKill: 0,
      cgroupEffectiveLimit: 500,
      cgroupLimitingUsage: 400,
      cgroupLimitingOom: 3,
      cgroupLimitingOomKill: 2,
    });
    files["/visible/memory.max"] = "300";
    expect(await reader()).toMatchObject({
      cgroupUsage: 100,
      cgroupEffectiveLimit: 300,
      cgroupLimitingUsage: 900,
      cgroupLimitingOom: 8,
      cgroupLimitingOomKill: 7,
    });
    expect(paths).not.toContain("/memory.max");
  });
  test("v1 supports memory controller mount and does not treat under_oom as event count", async () => {
    expect(
      await createCgroupReader(
        readerFor({
          "/proc/self/cgroup": "7:memory:/docker/a",
          "/proc/self/mountinfo":
            "1 0 0:1 /docker /memory rw - cgroup cgroup rw,memory",
          "/memory/a/memory.usage_in_bytes": "2048",
          "/memory/a/memory.limit_in_bytes": "4096",
          "/memory/a/memory.max_usage_in_bytes": "3000",
          "/memory/a/memory.oom_control":
            "oom_kill_disable 0\nunder_oom 1\noom_kill 7",
        }),
        "linux",
      )(),
    ).toEqual({
      cgroupUsage: 2048,
      cgroupLimit: 4096,
      cgroupPeak: 3000,
      cgroupOomKill: 7,
    });
  });
  test("omits unsupported, missing, malformed, unsafe and unlimited values", async () => {
    let calls = 0;
    expect(
      await createCgroupReader(async () => {
        calls++;
        return "1";
      }, "darwin")(),
    ).toEqual({});
    expect(calls).toBe(0);
    expect(await createCgroupReader(readerFor({}), "linux")()).toEqual({});
    expect(
      await createCgroupReader(
        readerFor({
          "/sys/fs/cgroup/memory.current": "not a number",
          "/sys/fs/cgroup/memory.max": "max",
          "/sys/fs/cgroup/memory.peak": "-1",
          "/sys/fs/cgroup/memory.events": "oom nonsense\noom_kill -3",
        }),
        "linux",
      )(),
    ).toEqual({});
    expect(
      await createCgroupReader(
        readerFor({
          "/sys/fs/cgroup/memory/memory.usage_in_bytes": "0",
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        }),
        "linux",
      )(),
    ).toEqual({ cgroupUsage: 0 });
  });
  test("cancellation stops filesystem discovery/sampling", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await createCgroupReader(async () => {
        throw new Error("must not read");
      }, "linux")(controller.signal),
    ).toEqual({});
  });
});

describe("runtime sampler", () => {
  test("exports OTel gauges with units and bounded structured logs; clears missing values", async () => {
    const captured = capturedMeter();
    const logs: [string, Record<string, number>][] = [];
    let tick = () => {};
    let cgroup: MemorySample = { cgroupUsage: 999, cgroupOom: 2 };
    const sampler = startRuntimeSampler({
      meter: captured.meter,
      readProcess: () =>
        ({
          rss: 123,
          heapUsed: 12,
          heapTotal: 24,
          external: 3,
          arrayBuffers: 2,
          uptime: 10,
          secret: 45,
        }) as MemorySample,
      readCgroup: async () => cgroup,
      tokenizerStats: () => ({
        threads: 2,
        activeJobs: 1,
        queuedJobs: 3,
        activeInputBytes: 50,
        queuedInputBytes: 70,
      }),
      schedule: (callback, interval) => {
        expect(interval).toBe(10_000);
        tick = callback;
        return () => {};
      },
      log: (message, attrs) => {
        logs.push([message, attrs]);
      },
      flush: async () => {},
    });
    await turn();
    expect(captured.collect()[RUNTIME_METRICS.rss[0]]).toBe(123);
    expect(captured.collect()[RUNTIME_METRICS.cgroupUsage[0]]).toBe(999);
    expect(
      captured.collect()[RUNTIME_METRICS.tokenizerQueuedInputBytes[0]],
    ).toBe(70);
    expect(captured.units.get(RUNTIME_METRICS.heapUsed[0])).toBe("By");
    expect(captured.units.get(RUNTIME_METRICS.uptime[0])).toBe("s");
    expect(logs[0]?.[0]).toBe("Runtime memory sample");
    expect(logs[0]?.[1]).not.toHaveProperty("secret");
    cgroup = {};
    tick();
    await turn();
    expect(captured.collect()).not.toHaveProperty(
      RUNTIME_METRICS.cgroupUsage[0],
    );
    await sampler.stop();
    expect(captured.collect()).toEqual({});
    expect(
      [...captured.callbacks.values()].every(
        (callbacks) => callbacks.size === 0,
      ),
    ).toBe(true);
  });
  test("does not overlap async samples; aborts in-flight reader and emits nothing after stop", async () => {
    let resolve: ((sample: MemorySample) => void) | undefined;
    let tick = () => {};
    let reads = 0;
    let cancelled = false;
    let signal: AbortSignal | undefined;
    let logs = 0;
    const sampler = startRuntimeSampler({
      meter: capturedMeter().meter,
      readProcess: () => ({ rss: 1 }),
      readCgroup: async (s) => {
        reads++;
        signal = s;
        return new Promise((r) => {
          resolve = r;
        });
      },
      schedule: (callback) => {
        tick = callback;
        return () => {
          cancelled = true;
        };
      },
      log: () => {
        logs++;
      },
    });
    tick();
    tick();
    expect(reads).toBe(1);
    const stopped = sampler.stop();
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    tick();
    resolve?.({ cgroupUsage: 10 });
    await stopped;
    expect(logs).toBe(0);
    expect(reads).toBe(1);
    await sampler.stop();
  });
  test("flush cadence honors operator interval and does not overlap flushes", async () => {
    let tick = () => {};
    let now = 0;
    let flushes = 0;
    let samples = 0;
    let release: (() => void) | undefined;
    const sampler = startRuntimeSampler({
      meter: capturedMeter().meter,
      readProcess: () => ({ rss: 1 }),
      readCgroup: async () => ({}),
      log: () => {
        samples++;
      },
      now: () => now,
      exportIntervalMs: 25_000,
      flush: async () => {
        flushes++;
        if (flushes > 1) return;
        await new Promise<void>((r) => {
          release = r;
        });
      },
      schedule: (callback) => {
        tick = callback;
        return () => {};
      },
    });
    await turn();
    now = 10_000;
    tick();
    await turn();
    expect(flushes).toBe(0);
    now = 30_000;
    tick();
    await turn();
    expect(flushes).toBe(1);
    const samplesBeforeSlowExport = samples;
    now = 60_000;
    tick();
    await turn();
    expect(flushes).toBe(1);
    expect(samples).toBe(samplesBeforeSlowExport + 1);
    release?.();
    await turn();
    await sampler.stop();
  });
  test("stop before the first export flushes a final snapshot before removing callbacks", async () => {
    const captured = capturedMeter();
    const exported: Record<string, number>[] = [];
    let rss = 10;
    const sampler = startRuntimeSampler({
      meter: captured.meter,
      readProcess: () => ({ rss }),
      readCgroup: async () => ({ cgroupUsage: 20 }),
      log: () => {},
      schedule: () => () => {},
      flush: async () => {
        exported.push(captured.collect());
      },
    });
    rss = 30;
    await sampler.stop();
    await sampler.stop();
    expect(exported).toEqual([
      {
        [RUNTIME_METRICS.rss[0]]: 30,
        [RUNTIME_METRICS.cgroupUsage[0]]: 20,
      },
    ]);
    expect(captured.collect()).toEqual({});
  });
  test("shutdown is bounded with a hung final or already-pending export", async () => {
    for (const alreadyPending of [false, true]) {
      const captured = capturedMeter();
      let now = 0;
      let tick = () => {};
      let flushes = 0;
      const sampler = startRuntimeSampler({
        meter: captured.meter,
        readProcess: () => ({ rss: 1 }),
        readCgroup: async () => ({}),
        log: () => {},
        intervalMs: 1,
        exportIntervalMs: 1,
        shutdownTimeoutMs: 20,
        now: () => now,
        schedule: (callback) => {
          tick = callback;
          return () => {};
        },
        flush: () => {
          flushes++;
          return new Promise(() => {});
        },
      });
      await turn();
      if (alreadyPending) {
        now = 1;
        tick();
        await turn();
      }
      const started = Date.now();
      await sampler.stop();
      expect(Date.now() - started).toBeLessThan(500);
      expect(flushes).toBe(1);
      expect(captured.collect()).toEqual({});
    }
  });
  test("hung sampling cannot block shutdown or resurrect removed callbacks later", async () => {
    const captured = capturedMeter();
    let release: ((value: MemorySample) => void) | undefined;
    let flushes = 0;
    const sampler = startRuntimeSampler({
      meter: captured.meter,
      shutdownTimeoutMs: 20,
      readProcess: () => ({ rss: 1 }),
      readCgroup: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      schedule: () => () => {},
      log: () => {
        throw new Error("must not log after stop");
      },
      flush: async () => {
        flushes++;
      },
    });
    await sampler.stop();
    release?.({ cgroupUsage: 10 });
    await turn();
    expect(captured.collect()).toEqual({});
    expect(flushes).toBe(0);
  });
  test("export intervals clamp to sampling resolution and invalid values use the default", async () => {
    for (const [requested, expected] of [
      [1, 100],
      [Number.NaN, 10_000],
      [0, 10_000],
      [-1, 10_000],
      [Infinity, 10_000],
    ]) {
      let now = 0;
      let tick = () => {};
      let flushes = 0;
      const sampler = startRuntimeSampler({
        meter: capturedMeter().meter,
        intervalMs: 100,
        exportIntervalMs: requested,
        readProcess: () => ({}),
        readCgroup: async () => ({}),
        log: () => {},
        now: () => now,
        schedule: (callback) => {
          tick = callback;
          return () => {};
        },
        flush: async () => {
          flushes++;
        },
      });
      await turn();
      now = (expected ?? 0) - 1;
      tick();
      await turn();
      expect(flushes).toBe(0);
      now++;
      tick();
      await turn();
      expect(flushes).toBe(1);
      await sampler.stop();
    }
  });
  test("disabled and invalid sampling intervals do not start work", async () => {
    let scheduled = 0;
    let reads = 0;
    for (const settings of [
      { enabled: false },
      { intervalMs: 0 },
      { intervalMs: -1 },
      { intervalMs: Number.NaN },
      { intervalMs: Infinity },
      { intervalMs: 2 ** 32 },
    ]) {
      const sampler = startRuntimeSampler({
        ...settings,
        readProcess: () => {
          reads++;
          return {};
        },
        schedule: () => {
          scheduled++;
          return () => {};
        },
      });
      await sampler.stop();
    }
    expect(scheduled).toBe(0);
    expect(reads).toBe(0);
  });
  test("all failing telemetry dependencies fail open and later samples recover", async () => {
    let tick = () => {};
    let reads = 0;
    const sampler = startRuntimeSampler({
      meter: {
        createObservableGauge() {
          throw new Error("instrumentation failed");
        },
      },
      readProcess: () => {
        reads++;
        throw new Error("memory unavailable");
      },
      readCgroup: async () => {
        throw new Error("proc unavailable");
      },
      tokenizerStats: () => {
        throw new Error("pool unavailable");
      },
      log: () => {
        throw new Error("log failure");
      },
      flush: async () => {
        throw new Error("export failed");
      },
      now: () => reads * 10_000,
      exportIntervalMs: 1,
      schedule: (callback) => {
        tick = callback;
        return () => {};
      },
    });
    await turn();
    tick();
    await turn();
    expect(reads).toBe(2);
    await sampler.stop();
  });
  test("filters invalid numeric samples and preserves genuine zero", async () => {
    const captured = capturedMeter();
    const sampler = startRuntimeSampler({
      meter: captured.meter,
      readProcess: () => ({
        rss: 0,
        heapUsed: -1,
        heapTotal: Infinity,
        uptime: Number.NaN,
      }),
      readCgroup: async () => ({}),
      log: () => {},
    });
    await turn();
    expect(captured.collect()).toEqual({ [RUNTIME_METRICS.rss[0]]: 0 });
    await sampler.stop();
  });
});
