// Workaround: logfire-js span() doesn't record exceptions like the Python SDK,
// and creates dangling unhandled promise rejections on error.
// See: https://github.com/pydantic/logfire-js/issues/101
// Delete this file when the upstream fix ships.

import {
  type Attributes,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const tracer = trace.getTracer("memory-engine");

export function span<R>(
  name: string,
  options: {
    attributes?: Record<string, unknown>;
    callback: (span: Span) => R;
  },
): R {
  return tracer.startActiveSpan(
    name,
    { attributes: options.attributes as Attributes },
    (s: Span) => {
      try {
        const result = options.callback(s);
        if (result instanceof Promise) {
          return result
            .catch((err: unknown) => {
              if (err instanceof Error) {
                s.recordException(err);
                s.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: err.message,
                });
              }
              throw err;
            })
            .finally(() => s.end()) as R;
        }
        s.end();
        return result;
      } catch (err) {
        if (err instanceof Error) {
          s.recordException(err);
          s.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });
        }
        s.end();
        throw err;
      }
    },
  );
}
