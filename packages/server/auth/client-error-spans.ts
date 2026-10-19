import { SpanStatusCode } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Better Auth's tracer marks every thrown APIError as an exception + ERROR
 * except 3xx redirects. A 4xx (invalid_grant, bad password) is the client's
 * mistake, not ours: keep those spans out of the red.
 */
export const betterAuthClientErrors: SpanProcessor = {
  onStart(span) {
    if (span.instrumentationScope.name !== "better-auth") return;
    const { recordException, setStatus } = span;
    let expected = false;
    span.recordException = (error, time) => {
      const status = (error as { statusCode?: unknown } | null)?.statusCode;
      if (typeof status === "number" && status >= 400 && status < 500) {
        expected = true;
        span.setAttribute("http.response.status_code", status);
        return;
      }
      recordException.call(span, error, time);
    };
    span.setStatus = (status) => {
      if (expected && status.code === SpanStatusCode.ERROR) return span;
      return setStatus.call(span, status);
    };
  },
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
};
