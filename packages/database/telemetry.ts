/**
 * `reportError`, wrapped so it also writes to stderr synchronously.
 *
 * logfire's `reportError` emits a buffered OTLP log record (its console
 * processor is span-only), so on a crash — e.g. a failed migration that aborts
 * server boot — the process can exit before the exporter flushes, losing the
 * cause from both the backend and `kubectl logs`. The synchronous `console.error`
 * guarantees the full error (stack + nested pg `cause`) is always in the logs.
 *
 * Lives in `database` because it's the lowest-level package every error-reporting
 * package depends on (server, worker, engine) and where the migration code that
 * raises the richest errors lives. Import `reportError` from here — directly
 * within `database`, or as `@memory.build/database/telemetry` elsewhere — instead
 * of from `@pydantic/logfire-node`, so every reported error is crash-visible.
 */
import { reportError as logfireReportError } from "@pydantic/logfire-node";

export function reportError(
  message: string,
  error: unknown,
  attributes?: Record<string, unknown>,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`${message}:`, err);
  logfireReportError(message, err, attributes);
}
