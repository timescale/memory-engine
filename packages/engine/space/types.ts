/**
 * Types for the space data-plane TS layer.
 *
 * Thin wrappers over the space SQL functions (packages/database/space/migrate/
 * idempotent/*.sql). Every method takes a `treeAccess` set — the jsonb produced
 * by core.buildTreeAccess — which the SQL functions use to enforce access.
 */

import type { TreeAccess } from "../core/types";

export type { TreeAccess };

/** tstzrange rendered as its text form, e.g. "[2024-01-01,2024-01-02)". */
export type TemporalRange = string;

/** Conflict action on the idempotency key (named rows: (tree, name); else id). */
export type OnConflict = "error" | "replace" | "ignore";

/** What a create/batchCreate did to one row. */
export type WriteStatus = "inserted" | "updated" | "skipped";

export interface Memory {
  id: string;
  tree: string;
  /** Optional, mutable leaf name; null for unnamed memories. */
  name: string | null;
  meta: Record<string, unknown>;
  temporal: TemporalRange | null;
  content: string;
  version: number;
  versionHash: string;
  hasEmbedding: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface SearchResultItem extends Memory {
  score: number;
}

export interface CreateMemoryParams {
  tree: string;
  content: string;
  /** Optional explicit id (preserves identity for import/export). */
  id?: string;
  /** Optional leaf name; the (tree, name) idempotency key when no id is given. */
  name?: string;
  meta?: Record<string, unknown>;
  temporal?: TemporalRange;
  /**
   * Action when the idempotency key conflicts: 'error' (default) raises,
   * 'replace' overwrites in place (a no-op unless content/meta/temporal differ),
   * 'ignore' skips. Returns null when the row is skipped (ignore, or replace
   * no-op). Deterministic-id importers pass 'replace' and stamp
   * meta.importer_version, so a version bump makes meta differ and re-renders.
   */
  onConflict?: OnConflict;
}

export interface MemoryPatch {
  tree?: string;
  /** null clears the name; a string sets/renames; undefined leaves it. */
  name?: string | null;
  meta?: Record<string, unknown>;
  temporal?: TemporalRange | null;
  content?: string;
}

export interface AppendMemoryParams {
  /** Text appended to the existing content (never empty at this layer). */
  content: string;
  /**
   * String inserted between the existing content and the appended text. Omitted
   * for empty existing content or when the content already ends with it;
   * existing content is never trimmed. Defaults to "\n\n" at the RPC boundary.
   */
  separator?: string;
  /**
   * Operation-scoped idempotency key. A retried/raced append carrying the same
   * key replays the stored result instead of concatenating twice. Must be
   * random per invocation — never derived from the content.
   */
  opKey: string;
  /**
   * Optional optimistic-concurrency guard: when supplied it must match the
   * current version_hash (else CONFLICT, no write); when omitted the append is
   * unconditional (the opKey, not the version, makes a retry safe).
   */
  priorVersionHash?: string;
}

/** Compact result of an append — never carries the memory body. */
export interface AppendResult {
  id: string;
  version: number;
  versionHash: string;
  /** Bytes added (separator + content), UTF-8. */
  appendedBytes: number;
  /** Character length of the memory content after the append. */
  contentLength: number;
  /** True when this call replayed a prior receipt rather than appending. */
  replayed: boolean;
}

/** Filters shared by search (and the count/list tree helpers where relevant). */
export interface MemoryFilters {
  /** ancestor-or-self match: only memories at/under this path. */
  ltree?: string;
  /** ltree lquery pattern. */
  lquery?: string;
  /** ltree full-text ltxtquery. */
  ltxtquery?: string;
  /** meta @> this object. */
  metaContains?: Record<string, unknown>;
  temporalWithin?: TemporalRange;
  temporalOverlaps?: TemporalRange;
  temporalBefore?: string;
  temporalAfter?: string;
  /** case-insensitive regexp on content (must be combined with another filter). */
  regexp?: string;
}

export interface SearchOptions extends MemoryFilters {
  /** BM25 full-text query string. Mutually exclusive with `vec`. */
  bm25?: string;
  /** Pre-computed query embedding. Mutually exclusive with `bm25`. */
  vec?: number[];
  /** Max cosine distance (only with `vec`). */
  maxVecDist?: number;
  limit?: number;
  /**
   * Result order for the **unranked** (filter-only) path: by id (chronological),
   * `"desc"` (default, newest first) or `"asc"` (oldest first). Ignored when a
   * `bm25`/`vec` query is present — those are ordered by relevance score.
   */
  order?: "asc" | "desc";
}

export interface HybridSearchOptions extends MemoryFilters {
  /** BM25 full-text query string (required). */
  bm25: string;
  /** Pre-computed query embedding (required). */
  vec: number[];
  maxVecDist?: number;
  /** RRF constant (default 60). */
  k?: number;
  /** Per-arm candidate pool size (default 30). */
  candidateLimit?: number;
  fulltextWeight?: number;
  semanticWeight?: number;
  limit?: number;
}

export interface TreeListEntry {
  tree: string;
  count: number;
}

/**
 * Space-wide embedding backlog snapshot (see the space `queue_stats()` function).
 *
 * Not tree-scoped: the queue depth is an operational property of the whole
 * space, so — unlike the memory read methods — `queueStats` takes no treeAccess.
 */
export interface QueueStats {
  /** Rows awaiting embedding (outcome is null): waiting + inFlight. */
  pending: number;
  /** Pending rows currently claimed by a worker (visibility timeout in the future). */
  inFlight: number;
  /** Pending rows claimable now (visibility timeout elapsed). */
  waiting: number;
  /** Terminal failures still within the prune retention window. */
  failed: number;
  /** Enqueue time of the oldest pending row; null when the queue is idle. */
  oldestPendingAt: Date | null;
}
