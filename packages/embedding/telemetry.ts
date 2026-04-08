// Workaround: logfire-js span() doesn't record exceptions like the Python SDK.
// See: https://github.com/pydantic/logfire-js/issues/101
// Delete this file when the upstream fix ships.

import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { span as logfireSpan } from "@pydantic/logfire-node";

export function span<R>(
  name: string,
  options: {
    attributes?: Record<string, unknown>;
    callback: (span: Span) => R;
  },
): R {
  return logfireSpan(name, {
    ...options,
    callback: (s: Span) => {
      try {
        const result = options.callback(s);
        if (result instanceof Promise) {
          return result.catch((err: unknown) => {
            if (err instanceof Error) {
              s.recordException(err);
              s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            }
            throw err;
          }) as R;
        }
        return result;
      } catch (err) {
        if (err instanceof Error) {
          s.recordException(err);
          s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        }
        throw err;
      }
    },
  });
}
