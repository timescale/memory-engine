import { expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { APIError } from "better-auth/api";
import { betterAuthClientErrors } from "./client-error-spans";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [betterAuthClientErrors, new SimpleSpanProcessor(exporter)],
});

// Mirrors Better Auth's endSpanWithError: recordException, setStatus(ERROR), end.
function failSpan(scope: string, error: Error) {
  const span = provider.getTracer(scope).startSpan("handler /oauth2/token");
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.end();
  return exporter.getFinishedSpans().at(-1);
}

test("Better Auth 4xx is not an error", () => {
  const span = failSpan(
    "better-auth",
    new APIError("BAD_REQUEST", { error: "invalid_grant" }),
  );
  expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  expect(span?.events).toEqual([]);
  expect(span?.attributes["http.response.status_code"]).toBe(400);
});

test("Better Auth 5xx and plain errors stay errors", () => {
  for (const error of [
    new APIError("INTERNAL_SERVER_ERROR"),
    new Error("db down"),
  ]) {
    const span = failSpan("better-auth", error);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((e) => e.name)).toEqual(["exception"]);
  }
});

test("other scopes are untouched", () => {
  const span = failSpan("other", new APIError("BAD_REQUEST"));
  expect(span?.status.code).toBe(SpanStatusCode.ERROR);
});
