import { expect, test } from "bun:test";

// Exercise the production entrypoint's real SDK configuration in isolated
// processes, with a loopback OTLP receiver. No tokens or traffic leave localhost.
for (const profile of ["lean", "diagnostic"] as const) {
  test(`${profile} profile exports traces and only explicitly opted-in metrics`, async () => {
    const script = `
      import assert from "node:assert/strict";
      import { gunzipSync } from "node:zlib";
      const received = [];
      const receiver = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
          let bytes = Buffer.from(await request.arrayBuffer());
          if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
          received.push({ path: new URL(request.url).pathname, bytes });
          return Response.json({});
        },
      });
      process.env.LOGFIRE_BASE_URL = "http://127.0.0.1:" + receiver.port;
      process.env.LOGFIRE_TOKEN = "local-test-token";
      process.env.LOGFIRE_SEND_TO_LOGFIRE = "true";
      process.env.LOGFIRE_TELEMETRY_PROFILE = ${JSON.stringify(profile)};
      // An inherited OTel exporter must not bypass the lean profile.
      process.env.OTEL_METRICS_EXPORTER = "otlp";
      process.env.OTEL_LOGS_EXPORTER = "none";
      process.env.OTEL_METRIC_EXPORT_INTERVAL = "1";
      const intervals = [];
      const nativeSetInterval = globalThis.setInterval;
      globalThis.setInterval = (callback, ms, ...args) => {
        intervals.push(ms);
        return nativeSetInterval(callback, ms, ...args);
      };
      const { configureTelemetry } = await import("./telemetry.ts");
      const telemetry = configureTelemetry("telemetry-contract-test");
      globalThis.setInterval = nativeSetInterval;
      // The diagnostic reader keeps its native 60s cadence even though the
      // ignored legacy interval variable above requests 1ms.
      assert.ok(intervals.includes(60000), "missing minute-resolution reader/snapshot timer");
      assert.ok(!intervals.includes(1), "legacy metric interval must not trigger rapid exports");
      if (${JSON.stringify(profile)} === "diagnostic") assert.ok(intervals.includes(10000));
      try {
        assert.equal(process.env.OTEL_METRICS_EXPORTER, "none");
        const { metrics } = await import("@opentelemetry/api");
        metrics.getMeter("telemetry-contract").createCounter("contract.counter").add(1);
        const { observeHttpRequest } = await import("./request-telemetry.ts");
        const { handleRpcRequest } = await import("./rpc/handler.ts");
        const { buildRegistry } = await import("./rpc/registry.ts");
        const { AppError } = await import("./rpc/errors.ts");
        const { z } = await import("zod");
        const registry = buildRegistry()
          .register("memory.search", z.object({ limit: z.number() }), () => ({ results: [{ content: "private-body" }] }))
          .register("expected", z.object({}), () => { throw new AppError("NOT_FOUND", "absent"); })
          .build();
        for (const method of ["memory.search", "expected"]) {
          const request = new Request("http://local/api/v1/memory/rpc", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method, params: method === "memory.search" ? { limit: 7 } : {}, id: 1 }) });
          const response = await observeHttpRequest(request, () => handleRpcRequest(request, registry, { space: { slug: "test-space" }, principalId: "caller-1", principalKind: "s" }));
          const body = await response.json();
          if (method === "memory.search") assert.equal(body.result.results.length, 1);
          else assert.equal(body.error.data.code, "NOT_FOUND");
        }
        // Simulate the SDK's native reader collection without waiting a minute.
        // Production has no sampler-driven periodic forceFlush path.
        const { forceFlush } = await import("@pydantic/logfire-node");
        await forceFlush({ timeoutMillis: 1000 });
        await telemetry.stop();
        const traceBodies = Buffer.concat(received.filter(r => r.path === "/v1/traces").map(r => r.bytes));
        for (const name of ["rpc.memory.search", "Runtime memory sample", "search.returned_count", "search.returned_text_bytes", "principal.id", "caller-1", "rpc.outcome", "business_error", "http.response.body.size"])
          assert.ok(traceBodies.includes(Buffer.from(name)), "missing trace field: " + name);
        assert.ok(!traceBodies.includes(Buffer.from("private-body")), "response body must not be captured");
        assert.ok(!traceBodies.includes(Buffer.from("cgroupUsage")));
        const metricRequests = received.filter(r => r.path === "/v1/metrics");
        if (${JSON.stringify(profile)} === "lean") {
          assert.equal(metricRequests.length, 0, "lean must export no metrics, including at shutdown");
        } else {
          assert.ok(metricRequests.length > 0, "diagnostic gauges must reach the explicitly configured exporter");
          const bodies = Buffer.concat(metricRequests.map(r => r.bytes));
          for (const name of ["contract.counter", "memory_engine.process.memory.rss", "memory_engine.tokenizer.queued_input", "memory_engine.http.requests.completed"])
            assert.ok(bodies.includes(Buffer.from(name)), "missing diagnostic metric: " + name);
          for (const name of ["v8js.", "nodejs.", "memory_engine.cgroup."])
            assert.ok(!bodies.includes(Buffer.from(name)), "unexpected metric family: " + name);
        }
      } finally {
        await telemetry.stop();
        await receiver.stop(true);
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        LOGFIRE_CONSOLE: "false",
        LOGFIRE_TRACE_SAMPLE_RATE: "1",
        LOGFIRE_MIN_LEVEL: "trace",
        LOGFIRE_RUNTIME_SAMPLE_INTERVAL_MS: "",
        OTEL_SDK_DISABLED: "false",
        OTEL_TRACES_SAMPLER: "always_on",
        // Avoid inherited standard OTLP destinations/headers in this local test.
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
        OTEL_EXPORTER_OTLP_HEADERS: "",
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: "",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stdout, stderr }).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    } finally {
      clearTimeout(timeout);
    }
  }, 10_000);
}
