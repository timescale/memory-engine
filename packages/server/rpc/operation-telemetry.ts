import type { HandlerContext } from "./types";

// Private capability: request bodies and string context keys cannot install a sink.
const mutationSink = Symbol("memory mutation telemetry");
type Sink = (attributes: Record<string, number | boolean>) => void;
type TelemetryContext = HandlerContext & { [mutationSink]?: Sink };

/** Operation row outcomes, not unique memories, logical versions, or audit events. */
export interface MemoryMutationCounts {
  inserted?: number;
  updated?: number;
  skipped?: number;
  deleted?: number;
  copied?: number;
  moved?: number;
  reverted?: number;
  dryRun?: boolean;
  preview?: number;
}

const countKeys = [
  "inserted",
  "updated",
  "skipped",
  "deleted",
  "copied",
  "moved",
  "reverted",
] as const;

export function withMutationTelemetry(
  context: HandlerContext,
  record: (attributes: Record<string, number | boolean>) => void,
): HandlerContext {
  try {
    return { ...context, [mutationSink]: record };
  } catch {
    return context;
  }
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Record only resolved store outcomes. Invalid/unavailable telemetry fails open. */
export function recordMemoryMutation(
  context: HandlerContext,
  counts: MemoryMutationCounts,
): void {
  try {
    const sink = (context as TelemetryContext)[mutationSink];
    if (!sink) return;
    const dryRun = counts.dryRun === undefined ? false : counts.dryRun;
    if (typeof dryRun !== "boolean") return;
    const attributes: Record<string, number | boolean> = {};
    let affected = 0;
    for (const key of countKeys) {
      const count = counts[key] === undefined ? 0 : counts[key];
      if (!validCount(count)) return;
      attributes[`memory.${key}_count`] = dryRun ? 0 : count;
      if (key !== "skipped" && !dryRun) affected += count;
    }
    if (!validCount(affected)) return;
    attributes["memory.affected_count"] = affected;
    attributes["memory.dry_run"] = dryRun;
    if (counts.preview !== undefined) {
      if (!validCount(counts.preview)) return;
      attributes["memory.preview_count"] = counts.preview;
    }
    sink(attributes);
  } catch {
    // Observability must never alter mutation results or error handling.
  }
}
