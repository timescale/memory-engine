import { describe, expect, test } from "bun:test";

// Providers are process-global. Exercise real SDK instruments/exporters in a
// child rather than mock.module (which poisons unrelated Bun test imports).
async function isolated(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      LOGFIRE_SEND_TO_LOGFIRE: "false",
      // NodeSDK 0.223 falls back to localhost OTLP if Logfire omits a signal
      // (e.g. metrics:false). Hermetic tests never use implicit exporters.
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}

const setup = `
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { metrics, trace } from "@opentelemetry/api";
const logfireDir = dirname(Bun.resolveSync("@pydantic/logfire-node", process.cwd()));
const metricSdk = await import(Bun.resolveSync("@opentelemetry/sdk-metrics", logfireDir));
const traceSdk = await import(Bun.resolveSync("@opentelemetry/sdk-trace-base", logfireDir));
const metricExporter = new metricSdk.InMemoryMetricExporter(metricSdk.AggregationTemporality.CUMULATIVE);
const reader = new metricSdk.PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3600000 });
const meterProvider = new metricSdk.MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(meterProvider);
const spanExporter = new traceSdk.InMemorySpanExporter();
const tracerProvider = new traceSdk.BasicTracerProvider({ spanProcessors: [new traceSdk.SimpleSpanProcessor(spanExporter)] });
trace.setGlobalTracerProvider(tracerProvider);
const { json, jsonResponseTelemetry, methodNotAllowed, tooManyRequests } = await import("./util/response.ts");
const { observeHttpRequest, httpMetricLabels, httpResponseTelemetryAttributes } = await import("./request-telemetry.ts");
const { handleRpcRequest } = await import("./rpc/handler.ts");
const { buildRegistry } = await import("./rpc/registry.ts");
const { AppError, APP_ERROR_CODES } = await import("./rpc/errors.ts");
const { z } = await import("zod");
async function points(name) {
  await reader.forceFlush();
  return metricExporter.getMetrics().at(-1).scopeMetrics.flatMap(s => s.metrics).find(m => m.descriptor.name === name);
}
`;

describe("request OOM observability (isolated real OTel SDK, no network)", () => {
  test("single JSON serialization, UTF-8 byte counts, unchanged wire semantics, no body clones", async () => {
    await isolated(`${setup}
      let serializations = 0;
      const response = json({ toJSON() { serializations++; return { content: "é🙂漢" }; } }, 201);
      assert.equal(serializations, 1);
      response.clone = () => { throw new Error("must not clone"); };
      const expected = '{"content":"é🙂漢"}';
      assert.equal(jsonResponseTelemetry(response)["http.response.body.size"], Buffer.byteLength(expected, "utf8"));
      assert.equal(httpResponseTelemetryAttributes(response)["http.response.body.size"], Buffer.byteLength(expected, "utf8"));
      assert.equal(response.bodyUsed, false);
      assert.equal(response.status, 201);
      assert.deepEqual([...response.headers], [["content-type", "application/json"]]);
      assert.equal(await response.text(), expected);
      assert.equal(serializations, 1);
      const size = await points("memory_engine.http.response.body.size");
      assert.equal(size.dataPoints[0].value.sum, Buffer.byteLength(expected, "utf8"));
      assert.deepEqual(size.dataPoints[0].attributes, {});
      assert.ok(size.dataPoints[0].value.buckets.boundaries.includes(67_108_864));
      json({ value: "x".repeat(100_000) });
      json({ value: "x".repeat(10_000_000) });
      const distribution = (await points("memory_engine.http.response.body.size")).dataPoints[0].value.buckets;
      const bucketFor = bytes => distribution.boundaries.findIndex(boundary => bytes <= boundary);
      const mediumBucket = bucketFor(100_012);
      const largeBucket = bucketFor(10_000_012);
      assert.notEqual(mediumBucket, largeBucket);
      assert.equal(distribution.counts[mediumBucket], 1);
      assert.equal(distribution.counts[largeBucket], 1);
      const duration = await points("memory_engine.http.response.serialization.duration");
      assert.equal(duration.dataPoints[0].value.count, 3);
      assert.ok(duration.dataPoints[0].value.sum >= 0);
      const allowed = methodNotAllowed(["POST"]);
      assert.equal(allowed.status, 405);
      assert.equal(allowed.headers.get("allow"), "POST");
      const limited = tooManyRequests(9);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "9");
      assert.ok(jsonResponseTelemetry(allowed));
      assert.ok(jsonResponseTelemetry(limited));
      assert.equal(jsonResponseTelemetry(new Response("unmeasured")), undefined);
      await meterProvider.shutdown(); await tracerProvider.shutdown();
    `);
  });

  test("real UpDownCounter tracks handler concurrency and cleans up throws; labels are bounded", async () => {
    await isolated(`${setup}
      const req = new Request("https://local/api/secret/path?credential=private", { method: "ATTACKER", headers: { "x-me-space": "spoofed" } });
      Object.defineProperty(req, "method", { value: "ATTACKER" });
      assert.deepEqual(httpMetricLabels(req), { "http.route": "/api/*", "http.request.method": "OTHER" });
      let resolve, reject;
      const first = observeHttpRequest(req, () => new Promise(r => { resolve = r; }));
      const second = observeHttpRequest(req, () => new Promise((_, r) => { reject = r; }));
      const caught = second.catch(e => e);
      const active = await points("memory_engine.http.requests.active");
      assert.equal(active.isMonotonic, false);
      assert.equal(active.dataPoints[0].value, 2);
      assert.deepEqual(active.dataPoints[0].attributes, {});
      resolve(json({ ok: true })); reject(new Error("handler failure"));
      await first; assert.equal((await caught).message, "handler failure");
      assert.equal((await points("memory_engine.http.requests.active")).dataPoints[0].value, 0);
      const completed = await points("memory_engine.http.requests.completed");
      assert.equal(completed.dataPoints.length, 2);
      for (const point of completed.dataPoints) {
        assert.deepEqual(Object.keys(point.attributes).sort(), ["http.outcome", "http.request.method", "http.response.status_code", "http.route"]);
        assert.equal(point.attributes["http.route"], "/api/*");
        assert.equal(point.attributes["http.request.method"], "OTHER");
      }
      assert.ok(completed.dataPoints.some(p => p.attributes["http.outcome"] === "exception"));
      await meterProvider.shutdown(); await tracerProvider.shutdown();
    `);
  });

  test("RPC spans summarize search and serialization without contents or spoofed identity; business errors stay expected", async () => {
    await isolated(`${setup}
      let serialized = 0;
      const registry = buildRegistry()
        .register("memory.search", z.object({ fulltext: z.string().nullable().optional(), semantic: z.string().nullable().optional(), limit: z.number().optional() }).passthrough(), () => ({ results: [{ content: "é🙂漢", meta: { private: "secret-meta" }, toJSON() { serialized++; return { content: this.content, meta: this.meta }; } }] }))
        .register("expected", z.object({}), () => { throw new AppError(APP_ERROR_CODES.NOT_FOUND, "absent"); })
        .register("unexpected", z.object({}), () => { throw new Error("genuine failure"); })
        .register("serializationFailure", z.object({}), () => ({ toJSON() { throw new Error("cannot serialize"); } }))
        .build();
      async function call(method, params, context = {}) {
        const request = new Request("https://local/api/v1/memory/rpc", { method: "POST", headers: { "x-me-space": "spoofed", "x-me-as-agent": "spoofed" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) });
        return handleRpcRequest(request, registry, context);
      }
      for (const [params, mode] of [[{ fulltext: "secret-query", semantic: "secret-semantic", limit: 7, tree: "secret-filter", meta: { private: "secret-param-meta" }, space: { slug: "spoofed" }, userId: "spoofed" }, "hybrid"], [{ fulltext: "secret-query" }, "fulltext"], [{ semantic: "secret-semantic" }, "semantic"], [{}, "filter"]]) {
        const response = await call("memory.search", params, { space: { slug: "a1b2c3d4e5f6" } });
        const attrs = spanExporter.getFinishedSpans().at(-1).attributes;
        assert.equal(attrs["search.mode"], mode);
        assert.equal(attrs["search.requested_limit"], params.limit ?? 10);
        assert.equal(attrs["search.returned_count"], 1);
        assert.equal(attrs["search.returned_text_bytes"], 9);
        assert.equal(attrs["space.slug"], "a1b2c3d4e5f6");
        assert.equal(attrs["http.response.body.size"], jsonResponseTelemetry(response)["http.response.body.size"]);
        assert.ok(attrs["response.serialization.duration_ms"] >= 0);
        const serializedAttrs = JSON.stringify(attrs);
        for (const secret of ["secret-query", "secret-semantic", "secret-meta", "secret-filter", "secret-param-meta", "é🙂漢", "spoofed"]) assert.ok(!serializedAttrs.includes(secret));
      }
      assert.equal(serialized, 4);
      await call("memory.search", {});
      assert.equal(spanExporter.getFinishedSpans().at(-1).attributes["space.slug"], undefined);
      const expected = await call("expected", {});
      assert.equal((await expected.json()).error.data.code, APP_ERROR_CODES.NOT_FOUND);
      const expectedSpan = spanExporter.getFinishedSpans().at(-1);
      assert.equal(expectedSpan.attributes["rpc.outcome"], "business_error");
      assert.equal(expectedSpan.events.filter(e => e.name === "exception").length, 0);
      assert.ok(expectedSpan.attributes["http.response.body.size"] > 0);
      for (const method of ["unexpected", "serializationFailure"]) {
        const failure = await call(method, {});
        assert.equal((await failure.json()).error.code, -32603);
        const failedSpan = spanExporter.getFinishedSpans().at(-1);
        assert.ok(failedSpan.events.some(e => e.name === "exception"));
        assert.notEqual(failedSpan.attributes["rpc.outcome"], "success");
      }
      await meterProvider.shutdown(); await tracerProvider.shutdown();
    `);
  });

  test("RPC principal identity uses authenticated user/service contexts, never headers or params", async () => {
    await isolated(`${setup}
      const registry = buildRegistry().register("memory.test", z.object({}).passthrough(), () => ({ ok: true })).build();
      const cases = [
        [{ principalId: "space-user", principalKind: "u", space: { slug: "space-a" } }, "space-user", "u"],
        [{ principalId: "space-service", principalKind: "s", space: { slug: "space-b" } }, "space-service", "s"],
        [{ userId: "account-user", kind: "u" }, "account-user", "u"],
        [{ userId: "account-service", kind: "s" }, "account-service", "s"],
        [{ principalId: "incomplete" }, undefined, undefined],
        [{ principalId: "group", principalKind: "g" }, undefined, undefined],
        [{ userId: "unknown-kind", kind: "g" }, undefined, undefined],
        [{}, undefined, undefined],
      ];
      for (const [context, id, kind] of cases) {
        const request = new Request("https://local/api/v1/memory/rpc", {
          method: "POST", headers: { "x-me-space": "spoofed-space", "x-principal-id": "spoofed-principal" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "memory.test", id: 1, params: { principalId: "spoofed-principal", principalKind: "s", userId: "spoofed-principal", kind: "s", space: { slug: "spoofed-space" } } }),
        });
        const response = await handleRpcRequest(request, registry, context);
        assert.equal(response.status, 200);
        const attrs = spanExporter.getFinishedSpans().at(-1).attributes;
        assert.equal(attrs["principal.id"], id);
        assert.equal(attrs["principal.kind"], kind);
        assert.equal(attrs["space.slug"], context.space?.slug);
        assert.ok(!JSON.stringify(attrs).includes("spoofed"));
      }
      await meterProvider.shutdown(); await tracerProvider.shutdown();
    `);
  });

  test("real memory RPC spans carry row outcomes, not inferred request counts or previews", async () => {
    await isolated(`${setup}
      const { memoryDataMethods } = await import("./rpc/memory/memory.ts");
      const id = "01900000-0000-7000-8000-000000000001";
      const stored = { id, tree: "share", name: "private-name", content: "private-body", meta: {}, temporal: null, version: 1, versionHash: "a".repeat(32), hasEmbedding: false, createdAt: new Date(0), updatedAt: null };
      let status = "inserted";
      const store = {
        async withEventContext(_event, fn) { return fn(store); },
        async createMemory() { return { id, status }; },
        async batchCreateMemories() { return ["inserted", "updated", "skipped"].map(status => ({ id, status })); },
        async getMemory() { return stored; },
        async copyTree() { return 12; },
        async patchMemory() { return true; },
        async deleteMemory() { return true; },
      };
      const context = { store, core: {}, space: { slug: "space-a" }, principalId: "01900000-0000-7000-8000-000000000002", principalKind: "s", principalName: "private-name", apiKeyId: null, apiKeyName: null, treeAccess: [] };
      async function call(method, params) {
        const response = await handleRpcRequest(new Request("https://local/api/v1/memory/rpc", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) }), memoryDataMethods, context);
        return { body: await response.json(), attrs: spanExporter.getFinishedSpans().findLast(s => s.name === "rpc." + method).attributes };
      }
      for (status of ["inserted", "updated", "skipped"]) {
        const { body, attrs } = await call("memory.create", { tree: "/share", content: "private-body", onConflict: "ignore" });
        assert.equal(body.result.id, id);
        assert.equal(body.result.status, undefined);
        assert.equal(attrs["memory." + status + "_count"], 1);
        assert.equal(attrs["memory.affected_count"], status === "skipped" ? 0 : 1);
        assert.equal(attrs["principal.id"], "01900000-0000-7000-8000-000000000002");
        assert.equal(attrs["principal.kind"], "s");
        assert.equal(attrs["space.slug"], "space-a");
      }
      const batch = await call("memory.batchCreate", { memories: Array.from({ length: 3 }, () => ({ tree: "/share", content: "private-body" })) });
      for (const key of ["inserted", "updated", "skipped"]) assert.equal(batch.attrs["memory." + key + "_count"], 1);
      assert.equal(batch.attrs["memory.affected_count"], 2);
      for (const dryRun of [true, false]) {
        const copied = await call("memory.copy", { source: "/share", destination: "/share/dest", dryRun });
        assert.equal(copied.body.result.count, 12);
        assert.equal(copied.attrs["memory.dry_run"], dryRun);
        assert.equal(copied.attrs["memory.copied_count"], dryRun ? 0 : 12);
        assert.equal(copied.attrs["memory.affected_count"], dryRun ? 0 : 12);
        assert.equal(copied.attrs["memory.preview_count"], dryRun ? 12 : undefined);
      }
      const updated = await call("memory.update", { id, versionHash: stored.versionHash, content: stored.content });
      assert.equal(updated.attrs["memory.updated_count"], 1);
      const deleted = await call("memory.delete", { id });
      assert.equal(deleted.attrs["memory.deleted_count"], 1);
      store.deleteMemory = async () => false;
      const missing = await call("memory.delete", { id });
      assert.equal(missing.attrs["rpc.outcome"], "business_error");
      assert.equal(missing.attrs["memory.affected_count"], undefined);
      status = "inserted";
      store.getMemory = async () => null;
      const failedRead = await call("memory.create", { tree: "/share", content: "private-body" });
      assert.equal(failedRead.attrs["rpc.outcome"], "error");
      assert.equal(failedRead.attrs["memory.inserted_count"], 1);
      assert.equal(failedRead.attrs["memory.affected_count"], 1);
      const attrs = spanExporter.getFinishedSpans().map(s => s.attributes);
      assert.ok(!JSON.stringify(attrs).includes("private-body"));
      assert.ok(!JSON.stringify(attrs).includes("private-name"));
      await meterProvider.shutdown(); await tracerProvider.shutdown();
    `);
  });

  test("production Logfire scrubbing retains numeric diagnostics without adding payloads", async () => {
    await isolated(`
      import assert from "node:assert/strict";
      import { dirname } from "node:path";
      import { configure, info, shutdown } from "@pydantic/logfire-node";
      const logfireDir = dirname(Bun.resolveSync("@pydantic/logfire-node", process.cwd()));
      const sdk = await import(Bun.resolveSync("@opentelemetry/sdk-trace-base", logfireDir));
      const exporter = new sdk.InMemorySpanExporter();
      configure({
        sendToLogfire: false, console: false, metrics: false,
        additionalSpanProcessors: [new sdk.SimpleSpanProcessor(exporter)],
        scrubbing: { extraPatterns: ["content", "embedding", "access_token", "refresh_token"] },
      });
      const { handleRpcRequest } = await import("./rpc/handler.ts");
      const { buildRegistry } = await import("./rpc/registry.ts");
      const { z } = await import("zod");
      const registry = buildRegistry().register("memory.search", z.object({ limit: z.number() }), () => ({ results: [{ content: "private🙂" }] })).build();
      const response = await handleRpcRequest(new Request("https://local/api/v1/memory/rpc", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "memory.search", params: { limit: 7 }, id: 1 }) }), registry, { space: { slug: "test-space" }, principalId: "01900000-0000-7000-8000-000000000001", principalKind: "s" });
      assert.equal(response.status, 200);
      const rpc = exporter.getFinishedSpans().find(s => s.name === "rpc.memory.search").attributes;
      assert.equal(rpc["principal.id"], "01900000-0000-7000-8000-000000000001");
      assert.equal(rpc["principal.kind"], "s");
      assert.equal(rpc["search.requested_limit"], 7);
      assert.equal(rpc["search.returned_count"], 1);
      assert.equal(rpc["search.returned_text_bytes"], 11);
      assert.ok(rpc["http.response.body.size"] > 11);
      info("Runtime memory sample", { rss: 1000, heapUsed: 500, tokenizerActiveJobs: 2, tokenizerQueuedInputBytes: 800 });
      const sample = exporter.getFinishedSpans().find(s => s.name === "Runtime memory sample").attributes;
      assert.equal(sample.rss, 1000);
      assert.equal(sample.tokenizerActiveJobs, 2);
      assert.equal(sample.tokenizerQueuedInputBytes, 800);
      assert.ok(!JSON.stringify(exporter.getFinishedSpans().map(s => s.attributes)).includes("private🙂"));
      await shutdown({ timeoutMillis: 1000 });
    `);
  });

  test("broken telemetry providers and attribute setters fail open without re-running handlers", async () => {
    await isolated(`
      import assert from "node:assert/strict";
      import { metrics } from "@opentelemetry/api";
      metrics.setGlobalMeterProvider({ getMeter() { throw new Error("broken telemetry"); } });
      const { json, jsonResponseTelemetry } = await import("./util/response.ts");
      const { observeHttpRequest, setTelemetryAttributes } = await import("./request-telemetry.ts");
      let calls = 0;
      const response = await observeHttpRequest(new Request("https://local"), async () => { calls++; return json({ ok: true }); });
      assert.equal(calls, 1);
      assert.deepEqual(await response.json(), { ok: true });
      assert.ok(jsonResponseTelemetry(response));
      setTelemetryAttributes({ setAttribute() { throw new Error("broken span"); } }, { "rpc.outcome": "success" });
      await assert.rejects(observeHttpRequest(new Request("https://local"), async () => { throw new Error("business failure"); }), /business failure/);
    `);
  });
});
