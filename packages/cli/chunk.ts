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
 * Soft byte budget per `memory.batchCreate` request body, in UTF-8 bytes.
 *
 * The server caps request bodies at 1 MiB by default
 * (`packages/server/middleware/size-limit.ts`). With a count-only cap of
 * 1000, a single chunk of moderately-sized assistant messages routinely
 * exceeds 1 MiB and the request is rejected with HTTP 413 — taking the
 * entire chunk down with it. We instead cut chunks early when their
 * estimated UTF-8 wire size approaches a budget that leaves room for the
 * JSON-RPC envelope plus headers.
 *
 * 768 KiB leaves ~256 KiB of headroom under the 1 MiB default server limit.
 * A single memory larger than the budget still gets sent in its own
 * singleton chunk; if the server rejects it, the per-chunk catch records
 * the failure without affecting siblings.
 */
export const BATCH_CREATE_BYTES_BUDGET = 768 * 1024;

/**
 * Approximate the UTF-8 wire size of a single `MemoryCreateParams` when
 * it lands inside a JSON-RPC `memory.batchCreate` request. Accurate
 * enough for chunking decisions; we don't model the envelope exactly.
 *
 * Uses `Buffer.byteLength(_, "utf8")` rather than `String.prototype.length`
 * (which counts UTF-16 code units) so non-ASCII content — CJK code blocks,
 * emoji, accented Latin — is sized at the byte count the server actually
 * sees on the wire, not the JS character count. For ASCII-only content
 * the two are identical; for CJK the byte count is ~3× the char count,
 * and for supplementary-plane emoji 2× (4 bytes vs 2 surrogate units).
 */
export function approxMemoryBytes(m: MemoryCreateParams): number {
  return Buffer.byteLength(JSON.stringify(m), "utf8");
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

/**
 * Minimal client shape `batchCreateChunked` needs. Structurally typed so
 * callers can pass an `EngineClient` or a stub in tests without coupling
 * this module to the full client surface.
 */
export interface BatchCreateClient {
  memory: {
    batchCreate: (params: {
      memories: MemoryCreateParams[];
    }) => Promise<{ ids: string[] }>;
  };
}

/** Result of a chunked `batchCreate` run. */
export interface BatchCreateChunkedResult {
  /** Ids the server confirmed inserted (across all successful chunks). */
  insertedIds: string[];
  /**
   * Explicit ids submitted in chunks that errored, flattened across all
   * failed chunks for callers that just need a set of "ids to exclude
   * from skip classification." For per-chunk error attribution use
   * `errors[].ids` instead.
   *
   * These were never processed by the server, so they are neither
   * inserted nor skipped.
   */
  failedIds: string[];
  /** One entry per failed chunk. */
  errors: Array<{
    /** 0-based index of the failed chunk in submission order. */
    chunkIndex: number;
    /** Total items in the chunk (including those without explicit ids). */
    itemCount: number;
    /** Explicit ids in this chunk (subset of `itemCount`). */
    ids: string[];
    error: string;
  }>;
}

/**
 * Run `client.memory.batchCreate` over `memories`, automatically slicing
 * the input into chunks that fit under the server's request-body limit.
 *
 * Chunks are sent sequentially. A failed chunk is recorded once in
 * `errors` and its explicit ids are added to `failedIds`; it does not
 * abort siblings. Successful chunks contribute to `insertedIds`.
 *
 * Note: the returned `insertedIds` may be shorter than the number of
 * inputs in successful chunks because the server uses
 * `ON CONFLICT (id) DO NOTHING`. Use `computeSkippedIds` (or, for packs,
 * `classifySkips` with `failedIds`) to classify the missing ids.
 */
export async function batchCreateChunked(
  client: BatchCreateClient,
  memories: MemoryCreateParams[],
): Promise<BatchCreateChunkedResult> {
  const insertedIds: string[] = [];
  const failedIds: string[] = [];
  const errors: BatchCreateChunkedResult["errors"] = [];
  let chunkIndex = 0;

  for (const chunk of chunkMemoriesForBatchCreate(memories)) {
    try {
      const { ids } = await client.memory.batchCreate({ memories: chunk });
      insertedIds.push(...ids);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const ids = chunk
        .map((p) => p.id)
        .filter((x): x is string => typeof x === "string");
      failedIds.push(...ids);
      errors.push({
        chunkIndex,
        itemCount: chunk.length,
        ids,
        error: msg,
      });
    }
    chunkIndex++;
  }

  return { insertedIds, failedIds, errors };
}
