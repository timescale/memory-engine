import type { Span } from "@opentelemetry/api";

/** Attributes that can be attached to spans and logs */
export type Attributes = Record<string, unknown>;

/** Options for creating spans */
export interface SpanOptions {
  /** Parent span for nesting */
  parentSpan?: Span;
  /** Tags to categorize the span */
  tags?: string[];
}

/** Options for logging */
export interface LogOptions {
  /** Parent span to associate with */
  parentSpan?: Span;
  /** Tags to categorize the log */
  tags?: string[];
}

/** Logfire SDK type (lazy loaded) */
export type LogfireSDK = typeof import("@pydantic/logfire-node");
