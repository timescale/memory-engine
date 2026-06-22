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

import type {
  MemoryCreateParams,
  MemoryWriteResult,
} from "@memory.build/protocol/memory";

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
 * callers can pass a `MemoryClient` or a stub in tests without coupling
 * this module to the full client surface.
 */
export interface BatchCreateClient {
  memory: {
    batchCreate: (params: {
      memories: MemoryCreateParams[];
      onConflict?: "error" | "replace" | "ignore";
    }) => Promise<{ results: MemoryWriteResult[] }>;
  };
}

/** Options applied to every chunk of a `batchCreateChunked` run. */
export interface BatchCreateChunkedOptions {
  /**
   * Conflict policy for every chunk's idempotency key (each row's id when
   * given, else its (tree, name) slot). The server defaults to "error"
   * (raise); file importers pass "ignore" so a re-import is a no-op rather
   * than failing, and "replace" overwrites in place when content/meta/temporal
   * differ — deterministic-id importers pass "replace" and stamp
   * meta.importer_version, so a version bump makes meta differ and re-renders.
   */
  onConflict?: "error" | "replace" | "ignore";
}

/**
 * One submitted memory's outcome from a chunked run. A superset of the wire
 * `MemoryWriteResult`: successful chunks yield the server's `{ id, status }`
 * (status 'inserted' | 'updated' | 'skipped', `id` always present); a failed
 * chunk yields `status: 'error'` for each of its rows, with `id` the row's
 * explicit id when it had one (echoed back) or `null` when it was submitted
 * without an id. The failure *message* lives once per chunk in `errors[]`.
 */
export interface ChunkWriteResult {
  id: string | null;
  status: MemoryWriteResult["status"] | "error";
}

/** Result of a chunked `batchCreate` run. */
export interface BatchCreateChunkedResult {
  /**
   * One row per submitted memory, in submission order — so `results[i]` is the
   * outcome of the i-th input (the same contract as the wire `batchCreate`,
   * extended with an 'error' status for inputs whose chunk failed). Filter by
   * status for inserted/updated/skipped/error counts and ids.
   */
  results: ChunkWriteResult[];
  /**
   * One entry per failed chunk, carrying the shared error message. Every row in
   * a failed chunk also appears in `results` as an 'error' row; this view groups
   * those failures with their message (and reports the full item count, which
   * includes rows submitted without an explicit id).
   */
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
 * Chunks are sent sequentially and a failed chunk does not abort its siblings.
 * Every input gets one `results` row in submission order: successful chunks
 * contribute the server's `{ id, status }`, and a failed chunk contributes an
 * 'error' row per input (its explicit id, else `null`). The failure message is
 * recorded once per chunk in `errors`.
 */
export async function batchCreateChunked(
  client: BatchCreateClient,
  memories: MemoryCreateParams[],
  options: BatchCreateChunkedOptions = {},
): Promise<BatchCreateChunkedResult> {
  const results: ChunkWriteResult[] = [];
  const errors: BatchCreateChunkedResult["errors"] = [];
  let chunkIndex = 0;

  for (const chunk of chunkMemoriesForBatchCreate(memories)) {
    try {
      const res = await client.memory.batchCreate({
        memories: chunk,
        ...(options.onConflict !== undefined
          ? { onConflict: options.onConflict }
          : {}),
      });
      results.push(...res.results);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Every row in the failed chunk gets an 'error' result (its explicit id,
      // else null), preserving the one-row-per-input contract.
      for (const p of chunk) {
        results.push({ id: p.id ?? null, status: "error" });
      }
      const ids = chunk
        .map((p) => p.id)
        .filter((x): x is string => typeof x === "string");
      errors.push({
        chunkIndex,
        itemCount: chunk.length,
        ids,
        error: msg,
      });
    }
    chunkIndex++;
  }

  return { results, errors };
}
