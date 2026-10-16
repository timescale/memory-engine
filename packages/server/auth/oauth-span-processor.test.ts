import { describe, expect, test } from "bun:test";

// Isolate globals and cached Better Auth OTel discovery from other Bun suites.
async function isolated(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      LOGFIRE_SEND_TO_LOGFIRE: "false",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_TRACES_EXPORTER: "none",
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

const imports = `
import assert from "node:assert/strict";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { APIError } from "better-auth/api";
import { APIError as BetterCallAPIError } from "better-call";
import { OAuthClientErrorSpanProcessor } from "./oauth-span-processor.ts";
const exporter = new InMemorySpanExporter();
const processor = new OAuthClientErrorSpanProcessor();
const route = "/oauth2/token";
const rejection = (status = 400, error = "invalid_grant", description = "session not found") => new APIError(status, { error, error_description: description });
function report(span, error) {
  span.recordException(error);
  assert.equal(span.setStatus({ code: SpanStatusCode.ERROR, message: String(error?.message ?? error) }), span);
}
function expected(span, status = 400, outcome = "invalid_grant") {
  assert.deepEqual(span.status, { code: SpanStatusCode.UNSET });
  assert.equal(span.attributes["logfire.level_num"], 9);
  assert.equal(span.attributes["oauth.grant.outcome"], outcome);
  assert.equal(span.attributes["error.expected"], true);
  assert.equal(span.attributes["http.response.status_code"], status);
  assert.deepEqual(span.events, []);
}
function failed(span, message) {
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.notEqual(span.attributes["error.expected"], true);
  assert.notEqual(span.attributes["logfire.level_num"], 9);
  assert.ok(span.events.some(e => e.name === "exception" && e.attributes["exception.message"] === (message || undefined)));
}
`;
const providerSetup = `${imports}
// Exporter deliberately precedes classifier: onEnd rewriting would be too late.
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter), processor] });
const tracer = provider.getTracer("better-auth", "1.6.20");
function start(name = "handler " + route, attrs = { "http.route": route }, scope = "better-auth") {
  return provider.getTracer(scope).startSpan(name, { attributes: attrs });
}
function finish(error, name, attrs, scope) {
  const span = start(name, attrs, scope);
  report(span, error); span.end();
  return exporter.getFinishedSpans().at(-1);
}
`;

describe("OAuth client rejection span processor (isolated real SDK)", () => {
  test("only typed allowlisted token endpoint rejections are info/UNSET without exception events", async () => {
    await isolated(`${providerSetup}
      assert.ok(new APIError(400) instanceof BetterCallAPIError);
      assert.ok(!(new BetterCallAPIError(400) instanceof APIError));
      for (const ErrorClass of [APIError, BetterCallAPIError]) {
      const rejection = (status = 400, error = "invalid_grant", description = "session not found") => new ErrorClass(status, { error, error_description: description });
      for (const status of [400, 401, 403]) {
        for (const code of ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope"]) {
          for (const name of ["handler " + route, "POST " + route]) expected(finish(rejection(status, code), name), status, code);
        }
      }
      const mapped = finish(rejection());
      assert.equal(mapped.attributes["oauth.grant.rejection_reason"], "refresh_token_not_found");
      const secret = "secret-refresh-token-client-input";
      const safe = finish(rejection(400, "invalid_grant", secret));
      expected(safe);
      assert.equal(safe.attributes["oauth.grant.rejection_reason"], "other");
      assert.deepEqual(Object.keys(safe.attributes).sort(), ["http.route", "http.response.status_code", "oauth.grant.outcome", "oauth.grant.rejection_reason", "error.expected", "logfire.level_num"].sort());
      assert.ok(!JSON.stringify({ attributes: safe.attributes, events: safe.events, status: safe.status }).includes(secret));
      for (const status of [200, 302, 404, 409, 422, 429, 500, 503]) {
        const error = rejection(status); failed(finish(error), error.message);
      }
      for (const code of ["unknown", "server_error", "temporarily_unavailable", "INVALID_GRANT", "invalid_grant ", undefined, 400]) {
        const error = new ErrorClass(400, { error: code }); failed(finish(error), error.message);
      }
      for (const name of ["handler /oauth2/authorize", "handler /oauth2/token/", "GET " + route, "hook before " + route, "db findOne oauthRefreshToken"]) {
        const error = rejection(); failed(finish(error, name), error.message);
      }
      for (const attrs of [{}, { "http.route": "/oauth2/token/" }, { "http.route": "/api/v1/auth/oauth2/token" }]) {
        const error = rejection(); failed(finish(error, undefined, attrs), error.message);
      }
      for (const scope of ["other", "better-auth-extra", "memory-engine"]) {
        const error = rejection(); failed(finish(error, undefined, undefined, scope), error.message);
      }
      for (const error of [new Error("database unavailable"), Object.assign(new Error("forged"), { name: "APIError", statusCode: 400, body: { error: "invalid_grant" } }), { name: "APIError", message: "forged object", statusCode: 400, body: { error: "invalid_grant" } }]) failed(finish(error), error.message);
      }
      await provider.shutdown();
    `);
  });

  test("success untouched, concurrent state independent, later and earlier real failures preserved", async () => {
    await isolated(`${providerSetup}
      const success = start(); success.setAttribute("existing", "value");
      assert.equal(success.setStatus({ code: SpanStatusCode.OK }), success);
      success.end();
      const ok = exporter.getFinishedSpans().at(-1);
      assert.deepEqual(ok.status, { code: SpanStatusCode.OK });
      assert.deepEqual(ok.attributes, { "http.route": route, existing: "value" });
      assert.deepEqual(ok.events, []);
      const unset = start(); unset.end();
      assert.deepEqual(exporter.getFinishedSpans().at(-1).attributes, { "http.route": route });
      await Promise.all(Array.from({ length: 20 }, async (_, i) => {
        const span = start(); await Promise.resolve();
        const error = i % 2 ? new Error("db-" + i) : rejection();
        report(span, error); await Promise.resolve(); span.end();
        const exported = exporter.getFinishedSpans().find(s => s.spanContext().spanId === span.spanContext().spanId);
        if (i % 2) failed(exported, error.message); else expected(exported);
      }));
      for (const ErrorClass of [APIError, BetterCallAPIError]) {
      const rejection = () => new ErrorClass(400, { error: "invalid_grant", error_description: "session not found" });
      for (const order of ["before", "after"]) {
        const span = start(); const error = new Error("real failure " + order);
        if (order === "before") report(span, error);
        report(span, rejection());
        if (order === "after") report(span, error);
        span.end(); failed(exporter.getFinishedSpans().at(-1), error.message);
      }
      const span = start(); const error = rejection(); report(span, error);
      // Even the same message on a later status call must not be suppressed.
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message }); span.end();
      const later = exporter.getFinishedSpans().at(-1);
      assert.equal(later.status.code, SpanStatusCode.ERROR);
      assert.equal(later.attributes["error.expected"], false);
      assert.equal(later.attributes["logfire.level_num"], 17);
      const mismatch = start(); mismatch.recordException(rejection());
      mismatch.setStatus({ code: SpanStatusCode.ERROR, message: "unrelated status" }); mismatch.end();
      assert.equal(exporter.getFinishedSpans().at(-1).status.message, "unrelated status");
      assert.equal(exporter.getFinishedSpans().at(-1).attributes["error.expected"], false);
      }
      await processor.forceFlush(); await processor.shutdown(); await provider.shutdown();
    `);
  });

  test("frozen spans and broken attribute instrumentation fail open", async () => {
    await isolated(`${providerSetup}
      const span = start();
      span.setAttributes = () => { throw new Error("telemetry setter broken"); };
      const error = rejection(); report(span, error); span.end();
      failed(exporter.getFinishedSpans().at(-1), error.message);
      const plainProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      const frozenMethods = plainProvider.getTracer("better-auth").startSpan("handler " + route, { attributes: { "http.route": route } });
      Object.defineProperty(frozenMethods, "setStatus", { value: frozenMethods.setStatus, writable: false });
      const original = frozenMethods.recordException;
      assert.doesNotThrow(() => processor.onStart(frozenMethods, context.active()));
      assert.equal(frozenMethods.recordException, original);
      report(frozenMethods, error); frozenMethods.end();
      failed(exporter.getFinishedSpans().at(-1), error.message);
      await provider.shutdown(); await plainProvider.shutdown();
    `);
  });

  test("Logfire additional processor classifies the actual Better Auth refresh endpoint without changing HTTP errors", async () => {
    await isolated(`${imports}
      import { configure, shutdown, span as logfireSpan } from "@pydantic/logfire-node";
      import { httpRequestTelemetryAttributes, tokenResponseTelemetryAttributes } from "../request-telemetry.ts";
      import { tokenRequestTelemetryAttributes } from "./oauth-request-metadata.ts";
      import { betterAuth } from "better-auth";
      import { memoryAdapter } from "better-auth/adapters/memory";
      import { oauthProvider } from "@better-auth/oauth-provider";
      let endpointError;
      let classificationEnabled = true;
      const endpointProcessor = new class extends OAuthClientErrorSpanProcessor {
        onStart(span, parent) {
          if (classificationEnabled) super.onStart(span, parent);
        }
      };
      // Observe the real exception before forwarding to the adapted method;
      // Better Auth handles these errors before its onAPIError callback.
      const observeErrors = {
        onStart(span) {
          if (span.name !== "handler " + route) return;
          const recordException = span.recordException;
          span.recordException = (error, time) => {
            endpointError = error;
            recordException.call(span, error, time);
          };
        },
        onEnd() {}, async forceFlush() {}, async shutdown() {},
      };
      configure({ sendToLogfire: false, console: false, metrics: false,
        nodeAutoInstrumentations: {
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-runtime-node": { enabled: false },
        },
        additionalSpanProcessors: [new SimpleSpanProcessor(exporter), endpointProcessor, observeErrors],
        scrubbing: { extraPatterns: ["content", "embedding", "access_token", "refresh_token"] },
      });
      // Check the final Logfire-exported failure details against an unadapted
      // real SDK span, not a mock or a ReadableSpan inspected before export.
      const baselineExporter = new InMemorySpanExporter();
      const baselineProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(baselineExporter)] });
      for (const error of [rejection(500), rejection(400, "not_allowlisted"), new Error("database unavailable")]) {
        const baseline = baselineProvider.getTracer("baseline").startSpan("handler " + route);
        report(baseline, error); baseline.end();
        const live = trace.getTracer("better-auth").startSpan("handler " + route, { attributes: { "http.route": route } });
        report(live, error); live.end();
        const actual = exporter.getFinishedSpans().at(-1);
        const original = baselineExporter.getFinishedSpans().at(-1);
        failed(actual, error.message);
        assert.equal(actual.attributes["logfire.level_num"], original.attributes["logfire.level_num"]);
        assert.deepEqual(actual.status, original.status);
        assert.deepEqual(actual.events.map(e => e.attributes), original.events.map(e => e.attributes));
      }
      await baselineProvider.shutdown();
      exporter.reset();
      const db = { user: [], session: [], account: [], verification: [], oauthRefreshToken: [], oauthClient: [], oauthAccessToken: [], oauthConsent: [] };
      const auth = betterAuth({
        baseURL: "http://localhost:3210", basePath: "/api/v1/auth",
        secret: "test-only-secret-at-least-32-characters-long",
        database: memoryAdapter(db), logger: { disabled: true }, rateLimit: { enabled: false },
        plugins: [oauthProvider({ loginPage: "/login", consentPage: "/consent", disableJwtPlugin: true })],
      });
      const request = new Request("http://localhost:3210/api/v1/auth/oauth2/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: "test-client", refresh_token: "test-secret-not-a-real-token" }),
      });
      const response = await logfireSpan("http.request", {
        attributes: httpRequestTelemetryAttributes(request),
        callback: async active => {
          const metadata = tokenRequestTelemetryAttributes(request);
          const response = await auth.handler(request);
          active.setAttributes(await metadata);
          active.setAttributes(await tokenResponseTelemetryAttributes(request, response));
          return response;
        },
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_grant", error_description: "session not found" });
      const spans = exporter.getFinishedSpans();
      const root = spans.find(s => s.name === "http.request");
      assert.ok(root);
      assert.equal(root.attributes["oauth.grant.type"], "refresh_token");
      assert.equal(root.attributes["oauth.client_id"], "other");
      assert.match(root.attributes["oauth.client_id_hash"], /^[0-9a-f]{64}$/);
      assert.equal(root.attributes["oauth.grant.rejection_reason"], "refresh_token_not_found");
      assert.equal(root.attributes["error.expected"], true);
      assert.notEqual(root.status.code, SpanStatusCode.ERROR);
      const handler = spans.find(s => s.name === "handler /oauth2/token");
      assert.ok(handler, spans.map(s => s.name).join(", ")); expected(handler);
      assert.equal(handler.attributes["oauth.grant.rejection_reason"], "refresh_token_not_found");
      assert.equal(handler.instrumentationScope.name, "better-auth");
      const parent = spans.find(s => s.name === "POST /oauth2/token");
      assert.ok(parent); assert.equal(handler.parentSpanContext.spanId, parent.spanContext().spanId);
      assert.notEqual(parent.status.code, SpanStatusCode.ERROR);
      assert.ok(!JSON.stringify(spans.map(s => ({ attrs: s.attributes, events: s.events, status: s.status }))).includes("test-secret-not-a-real-token"));
      assert.ok(endpointError instanceof APIError);

      // A valid stored refresh token gets past the grant's early checks and
      // reaches the pinned provider's real better-call credential validation.
      const { createHash } = await import("node:crypto");
      const hash = value => createHash("sha256").update(value).digest("base64url");
      const refreshToken = "test-only-valid-refresh-token";
      const clientSecret = "test-only-correct-client-secret";
      const { symmetricEncrypt } = await import("better-auth/crypto");
      const storedClientSecret = await symmetricEncrypt({ key: (await auth.$context).secretConfig, data: clientSecret });
      db.oauthRefreshToken.push({ id: "refresh-id", token: hash(refreshToken), clientId: "test-client",
        userId: "unused-user", scopes: ["read"], expiresAt: new Date(Date.now() + 60_000), revoked: false });
      const cases = [
        { client: { disabled: true }, status: 400, error: "invalid_client", description: "client is disabled" },
        { client: { public: false, clientSecret: storedClientSecret }, fields: { client_secret: "test-only-wrong-client-secret" }, status: 401, error: "invalid_client", description: "invalid client_secret" },
        { client: { grantTypes: ["client_credentials"] }, status: 400, error: "unauthorized_client", description: "client is not authorized to use grant type refresh_token" },
        { client: { scopes: [] }, status: 400, error: "invalid_scope", description: "client does not allow scope read" },
        { headers: { authorization: "Basic " + btoa("malformed-test-only-header") }, status: 400, error: "invalid_client", description: "invalid authorization header format" },
      ];
      for (const scenario of cases) {
        exporter.reset(); endpointError = undefined;
        db.oauthClient.splice(0, db.oauthClient.length, { id: "client-id", clientId: "test-client",
          public: true, disabled: false, grantTypes: ["authorization_code"], scopes: ["read"], ...scenario.client });
        const request = new Request("http://localhost:3210/api/v1/auth/oauth2/token", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...scenario.headers },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: "test-client", refresh_token: refreshToken, ...scenario.fields }),
        });
        // Compare each real HTTP response with classification disabled. This
        // also proves the fixture originally produced ERROR + an exception.
        classificationEnabled = false;
        const baseline = await auth.handler(request.clone());
        const baselineBody = await baseline.text();
        const baselineHandler = exporter.getFinishedSpans().find(s => s.name === "handler " + route);
        assert.ok(baselineHandler); failed(baselineHandler, endpointError.message);
        classificationEnabled = true;
        exporter.reset(); endpointError = undefined;
        const response = await logfireSpan("http.request", {
          attributes: httpRequestTelemetryAttributes(request),
          callback: async active => {
            const response = await auth.handler(request);
            active.setAttributes(await tokenResponseTelemetryAttributes(request, response));
            return response;
          },
        });
        assert.equal(response.status, baseline.status);
        assert.deepEqual([...response.headers], [...baseline.headers]);
        assert.equal(await response.clone().text(), baselineBody);
        assert.equal(response.status, scenario.status);
        assert.deepEqual(await response.json(), { error: scenario.error, error_description: scenario.description });
        // Prove these regressions exercise the distinct class the old gate missed.
        assert.ok(endpointError instanceof BetterCallAPIError);
        assert.ok(!(endpointError instanceof APIError));
        const spans = exporter.getFinishedSpans();
        const handler = spans.find(s => s.name === "handler /oauth2/token");
        assert.ok(handler); expected(handler, scenario.status, scenario.error);
        const root = spans.find(s => s.name === "http.request");
        assert.ok(root);
        assert.equal(root.attributes["error.expected"], true);
        assert.equal(root.attributes["oauth.grant.outcome"], scenario.error);
        assert.notEqual(root.status.code, SpanStatusCode.ERROR);
        const parent = spans.find(s => s.name === "POST /oauth2/token");
        assert.ok(parent); assert.equal(handler.parentSpanContext.spanId, parent.spanContext().spanId);
        assert.notEqual(parent.status.code, SpanStatusCode.ERROR);
        assert.deepEqual(parent.events, []);
        const exported = JSON.stringify(spans.map(s => ({ attrs: s.attributes, events: s.events, status: s.status })));
        for (const secret of [refreshToken, clientSecret, "test-only-wrong-client-secret", "malformed-test-only-header"]) assert.ok(!exported.includes(secret));
      }
      await shutdown({ timeoutMillis: 1000 });
    `);
  });
});
