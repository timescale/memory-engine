import { getSDK } from "./config";
import type { Attributes, LogOptions } from "./types";

/**
 * Log a trace-level message (lowest severity).
 * Use for detailed debugging information.
 */
export function trace(
  message: string,
  attributes?: Attributes,
  options?: LogOptions,
): void {
  const sdk = getSDK();
  if (!sdk) return;
  sdk.trace(message, attributes ?? {}, {
    parentSpan: options?.parentSpan,
    tags: options?.tags,
  });
}

/**
 * Log a debug-level message.
 * Use for debugging information useful during development.
 */
export function debug(
  message: string,
  attributes?: Attributes,
  options?: LogOptions,
): void {
  const sdk = getSDK();
  if (!sdk) return;
  sdk.debug(message, attributes ?? {}, {
    parentSpan: options?.parentSpan,
    tags: options?.tags,
  });
}

/**
 * Log an info-level message.
 * Use for general informational messages about normal operation.
 */
export function info(
  message: string,
  attributes?: Attributes,
  options?: LogOptions,
): void {
  const sdk = getSDK();
  if (!sdk) return;
  sdk.info(message, attributes ?? {}, {
    parentSpan: options?.parentSpan,
    tags: options?.tags,
  });
}

/**
 * Log a warning-level message.
 * Use for potentially harmful situations that don't prevent operation.
 */
export function warn(
  message: string,
  attributes?: Attributes,
  options?: LogOptions,
): void {
  const sdk = getSDK();
  if (!sdk) return;
  sdk.warning(message, attributes ?? {}, {
    parentSpan: options?.parentSpan,
    tags: options?.tags,
  });
}

/**
 * Log an error-level message.
 * Use for error events that might still allow the application to continue.
 */
export function error(
  message: string,
  attributes?: Attributes,
  options?: LogOptions,
): void {
  const sdk = getSDK();
  if (!sdk) return;
  sdk.error(message, attributes ?? {}, {
    parentSpan: options?.parentSpan,
    tags: options?.tags,
  });
}

/**
 * Log a fatal-level message (highest severity).
 * Use for severe errors that will cause the application to terminate.
 */
export function fatal(
  message: string,
  attributes?: Attributes,
  options?: LogOptions,
): void {
  const sdk = getSDK();
  if (!sdk) return;
  sdk.fatal(message, attributes ?? {}, {
    parentSpan: options?.parentSpan,
    tags: options?.tags,
  });
}

/**
 * Report an error with full context: message, stack trace, exception details,
 * and fingerprint for issue grouping.
 *
 * This is the preferred way to report errors - it captures everything needed
 * for debugging: the error message, full stack trace, exception type, and
 * computes a fingerprint for grouping similar errors in Logfire.
 *
 * @example
 * try {
 *   await processData()
 * } catch (e) {
 *   reportError('Failed to process data', e as Error, {
 *     dataId: data.id,
 *     attempt: retryCount,
 *   })
 *   throw e // Re-throw if needed
 * }
 */
export function reportError(
  message: string,
  err: Error,
  attributes?: Attributes,
): void {
  const sdk = getSDK();
  if (!sdk) {
    // When Logfire is disabled, fall back to console.error for visibility
    console.error(message, err, attributes);
    return;
  }
  sdk.reportError(message, err, attributes ?? {});
}
