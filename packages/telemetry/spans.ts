import type { Span } from "@opentelemetry/api";
import { getSDK } from "./config";
import type { Attributes, SpanOptions } from "./types";

/**
 * No-op span that does nothing but satisfies the Span interface.
 * Used when Logfire is disabled.
 */
const noopSpan: Span = {
  spanContext: () => ({
    traceId: "",
    spanId: "",
    traceFlags: 0,
  }),
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  addLink: () => noopSpan,
  addLinks: () => noopSpan,
  setStatus: () => noopSpan,
  updateName: () => noopSpan,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
};

/**
 * Start a span without setting it on context.
 * You must call span.end() when done.
 *
 * @example
 * const span = startSpan('my.operation', { key: 'value' })
 * try {
 *   // do work
 *   span.end()
 * } catch (e) {
 *   span.recordException(e as Error)
 *   span.setStatus({ code: SpanStatusCode.ERROR })
 *   span.end()
 *   throw e
 * }
 */
export function startSpan(
  name: string,
  attributes?: Attributes,
  options?: SpanOptions,
): Span {
  const sdk = getSDK();
  if (!sdk) return noopSpan;

  return sdk.startSpan(name, attributes ?? {}, {
    parentSpan: options?.parentSpan,
    tags: options?.tags,
  });
}

/**
 * Run a function inside a span. The span is automatically ended when
 * the function completes (including async functions).
 *
 * If the function throws, the error is recorded on the span with full
 * stack trace before re-throwing.
 *
 * @example
 * // Sync
 * const result = withSpan('compute', { input: 42 }, () => {
 *   return heavyComputation()
 * })
 *
 * // Async
 * const data = await withSpan('fetch.data', { url }, async () => {
 *   return await fetch(url).then(r => r.json())
 * })
 */
export function withSpan<R>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => R,
  options?: SpanOptions,
): R {
  const sdk = getSDK();
  if (!sdk) return fn(noopSpan);

  return sdk.span(name, {
    attributes,
    parentSpan: options?.parentSpan,
    tags: options?.tags,
    callback: (span: Span) => {
      try {
        const result = fn(span);

        // Handle promises - record exceptions if they reject
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            if (error instanceof Error) {
              span.recordException(error);
            }
            throw error;
          }) as R;
        }

        return result;
      } catch (error) {
        // Sync error - record and re-throw
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      }
    },
  });
}
