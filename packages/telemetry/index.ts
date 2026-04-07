/**
 * @memory-engine/telemetry
 *
 * Observability for Memory Engine using Pydantic Logfire.
 *
 * Features:
 * - Lazy SDK loading (zero overhead when disabled)
 * - No-op pattern (all functions work even when disabled)
 * - Automatic scrubbing of sensitive data (passwords, tokens, memory content)
 * - Full error context (stack traces, exception details, fingerprints)
 *
 * Usage:
 * ```typescript
 * import { configure, withSpan, info, reportError } from '@memory-engine/telemetry'
 *
 * // Initialize at startup (before Bun.serve)
 * await configure()
 *
 * // Create spans for operations
 * const result = await withSpan('db.query', { table: 'memory' }, async () => {
 *   return await sql`SELECT * FROM memory`
 * })
 *
 * // Log events
 * info('Request completed', { method: 'POST', path: '/rpc' })
 *
 * // Report errors with full context
 * try {
 *   await riskyOperation()
 * } catch (e) {
 *   reportError('Operation failed', e as Error, { context: 'additional info' })
 *   throw e
 * }
 * ```
 *
 * Configuration:
 * Set LOGFIRE_TOKEN environment variable to enable telemetry.
 * When not set, all functions are no-ops with zero overhead.
 */

// Configuration
export { configure, isEnabled } from "./config";

// Spans
export { startSpan, withSpan } from "./spans";

// Logging
export {
  debug,
  error,
  fatal,
  info,
  reportError,
  trace,
  warn,
} from "./logs";

// Types
export type { Attributes, LogOptions, SpanOptions } from "./types";

// Re-export Span type for consumers who need to type span parameters
export type { Span } from "@opentelemetry/api";
