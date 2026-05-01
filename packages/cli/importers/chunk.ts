/**
 * Byte-aware chunker for `memory.batchCreate` requests.
 *
 * Callers (the agent-session importer, `me memory import`, the MCP import
 * tool, `me pack install`) need to slice large insert sets into chunks
 * small enough to fit under the server's request-body limit. A count-only
 * cap is not enough: a single assistant turn with a large code block or
 * tool result routinely exceeds 1 KB on its own, so a 1000-item chunk can
 * easily blow past the server's 1 MiB cap and get rejected with HTTP 413.
 *
 * This module provides the generic plumbing (`chunkByBytes`) plus the
 * importer-shaped defaults (`BATCH_CREATE_BYTES_BUDGET`, `BATCH_CREATE_CHUNK`,
 * `approxMemoryBytes`) and a one-line wrapper (`chunkMemoriesForBatchCreate`)
 * that callers should reach for unless they need a custom budget.
 */

import type { MemoryCreateParams } from "@memory.build/protocol/engine";

/**
 * Hard cap on memories per `memory.batchCreate` call. Matches the protocol
 * limit; sessions or imports with more than this get split into chunks.
 */
export const BATCH_CREATE_CHUNK = 1000;

/**
 * Soft byte budget per `memory.batchCreate` request body.
 *
 * The server caps request bodies at 1 MiB by default
 * (`packages/server/middleware/size-limit.ts`). With a count-only cap of
 * 1000, a single chunk of moderately-sized assistant messages routinely
 * exceeds 1 MiB and the request is rejected with HTTP 413 — taking the
 * entire chunk down with it. We instead cut chunks early when their
 * estimated wire size approaches a budget that leaves room for the
 * JSON-RPC envelope plus headers.
 *
 * 768 KiB leaves ~256 KiB of headroom under the 1 MiB default server limit.
 * A single memory larger than the budget still gets sent in its own
 * singleton chunk; if the server rejects it, the per-chunk catch records
 * the failure without affecting siblings.
 */
export const BATCH_CREATE_BYTES_BUDGET = 768 * 1024;

/**
 * Approximate the wire size of a single `MemoryCreateParams` when it lands
 * inside a JSON-RPC `memory.batchCreate` request. Accurate enough for
 * chunking decisions; we don't need to model the envelope exactly.
 */
export function approxMemoryBytes(m: MemoryCreateParams): number {
  return JSON.stringify(m).length;
}

/**
 * Split `items` into chunks where each chunk's summed `size(item)` stays
 * under `byteBudget`, capped at `countCap` items per chunk. An item whose
 * own size exceeds the budget gets its own singleton chunk so the caller
 * can still attempt it (and fail loudly server-side, rather than silently
 * dropping it client-side).
 *
 * Exported for unit testing and direct use by callers that need a custom
 * budget. Most callers should use `chunkMemoriesForBatchCreate` instead.
 */
export function* chunkByBytes<T>(
  items: T[],
  byteBudget: number,
  countCap: number,
  size: (item: T) => number,
): Generator<T[]> {
  let chunk: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = size(item);
    const wouldOverflow = chunk.length > 0 && bytes + itemBytes > byteBudget;
    const atCountCap = chunk.length >= countCap;
    if (wouldOverflow || atCountCap) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(item);
    bytes += itemBytes;
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * Convenience wrapper: chunk a `MemoryCreateParams[]` for `batchCreate`
 * using the importer-shaped defaults — 1 MiB-aware byte budget, 1000-item
 * count cap, JSON-stringify size estimate. Use this unless you have a
 * specific reason to override the defaults.
 */
export function* chunkMemoriesForBatchCreate(
  items: MemoryCreateParams[],
): Generator<MemoryCreateParams[]> {
  yield* chunkByBytes(
    items,
    BATCH_CREATE_BYTES_BUDGET,
    BATCH_CREATE_CHUNK,
    approxMemoryBytes,
  );
}
