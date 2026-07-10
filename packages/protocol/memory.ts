/**
 * Memory method schemas — params and results for memory.* RPC methods.
 */
import { z } from "zod";
import {
  memoryNameSchema,
  memoryPathSchema,
  metaSchema,
  onConflictSchema,
  searchWeightsSchema,
  temporalFilterSchema,
  temporalSchema,
  treeFilterSchema,
  treePathSchema,
  uuidv7Schema,
  writeStatusSchema,
} from "./fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * memory.create params.
 *
 * `id` is optional — supply it to preserve identity (import/export, deterministic
 * importers); omit it for a server-generated uuidv7. `name` is the optional leaf
 * slug. `onConflict` governs a clash on the idempotency key (a named row's
 * (tree, name) slot, which takes precedence over id; else the explicit id):
 * default `error`.
 */
export const memoryCreateParams = z.object({
  id: uuidv7Schema.optional().nullable(),
  content: z.string().min(1, "content is required"),
  meta: metaSchema.optional().nullable(),
  tree: treePathSchema.min(1, "tree path is required"),
  name: memoryNameSchema.optional().nullable(),
  temporal: temporalSchema.optional().nullable(),
  onConflict: onConflictSchema.optional().nullable(),
});

export type MemoryCreateParams = z.infer<typeof memoryCreateParams>;

/**
 * memory.batchCreate params.
 *
 * `onConflict` governs a clash on each row's idempotency key (a named row's
 * (tree, name) slot, which takes precedence over id; else its explicit id):
 * `error` (default) raises, `replace` overwrites in place when
 * content/meta/temporal differ (a no-op when identical), `ignore` skips.
 * Deterministic-id importers pass `replace` and stamp
 * `meta.importer_version`, so an unchanged re-import is a no-op while a version
 * bump makes meta differ and re-renders.
 */
export const memoryBatchCreateParams = z.object({
  memories: z
    .array(
      z.object({
        id: uuidv7Schema.optional().nullable(),
        content: z.string().min(1, "content is required"),
        meta: metaSchema.optional().nullable(),
        tree: treePathSchema.min(1, "tree path is required"),
        name: memoryNameSchema.optional().nullable(),
        temporal: temporalSchema.optional().nullable(),
      }),
    )
    .min(1, "at least one memory required")
    .max(1000, "maximum 1000 memories per batch"),
  onConflict: onConflictSchema.optional().nullable(),
});

export type MemoryBatchCreateParams = z.infer<typeof memoryBatchCreateParams>;

/**
 * memory.get params — by id. To address by the `tree/name` form use
 * memory.getByPath.
 */
export const memoryGetParams = z.object({
  id: uuidv7Schema,
});

export type MemoryGetParams = z.infer<typeof memoryGetParams>;

/**
 * memory.getByPath params — address a named memory by its `tree/name` path
 * (e.g. "share/auth/jwt-rotation"). The server splits at the final `/`: the
 * last segment is the name, the rest is the tree (with `~`/separators
 * normalized). The leaf must be a valid memory name (VALIDATION_ERROR
 * otherwise); NOT_FOUND when no such named memory exists.
 */
export const memoryGetByPathParams = z.object({
  path: memoryPathSchema,
});

export type MemoryGetByPathParams = z.infer<typeof memoryGetByPathParams>;

/**
 * memory.update params.
 */
export const memoryUpdateParams = z.object({
  id: uuidv7Schema,
  versionHash: z.string().length(32, "versionHash must be an md5 hex string"),
  content: z.string().min(1).optional().nullable(),
  meta: metaSchema.optional().nullable(),
  tree: treePathSchema.optional().nullable(),
  // null clears the name; a string sets/renames; omitted leaves it unchanged.
  name: memoryNameSchema.optional().nullable(),
  temporal: temporalSchema.optional().nullable(),
});

export type MemoryUpdateParams = z.infer<typeof memoryUpdateParams>;

/**
 * memory.append params — append to a memory's content by id.
 *
 * The append is one atomic server-side update; the body is never round-tripped.
 * `separator` (default "\n\n") joins the existing content and `content`, and is
 * omitted for empty existing content or when it already ends with the separator
 * — existing content is never trimmed. `idempotencyKey` is an operation-scoped,
 * random-per-invocation key: a retried/raced append with the same key replays
 * its prior result rather than concatenating twice, and the same key with a
 * different request is a CONFLICT. `versionHash` is OPTIONAL optimistic
 * concurrency — when supplied it must match (else CONFLICT, no write); when
 * omitted the append is unconditional. (Address by `tree/name` path from the
 * CLI/MCP, which resolve it to the immutable id before calling.)
 */
export const memoryAppendParams = z.object({
  id: uuidv7Schema,
  content: z.string().min(1, "content is required"),
  separator: z
    .string()
    .max(64, "separator must be at most 64 characters")
    .optional()
    .nullable(),
  versionHash: z
    .string()
    .length(32, "versionHash must be an md5 hex string")
    .optional()
    .nullable(),
  idempotencyKey: z
    .string()
    .min(1, "idempotencyKey is required")
    .max(255, "idempotencyKey must be at most 255 characters"),
});

export type MemoryAppendParams = z.infer<typeof memoryAppendParams>;

/**
 * memory.delete params — delete one memory by id. (Address a named memory by
 * its path with memory.deleteByPath; delete a whole subtree with deleteTree.)
 */
export const memoryDeleteParams = z.object({
  id: uuidv7Schema,
});

export type MemoryDeleteParams = z.infer<typeof memoryDeleteParams>;

/**
 * memory.deleteByPath params — delete one named memory by its `tree/name`
 * path (split like memory.getByPath). The leaf must be a valid memory name
 * (VALIDATION_ERROR otherwise); NOT_FOUND when it doesn't resolve.
 */
export const memoryDeleteByPathParams = z.object({
  path: memoryPathSchema,
});

export type MemoryDeleteByPathParams = z.infer<typeof memoryDeleteByPathParams>;

/**
 * memory.search params.
 */
export const memorySearchParams = z.object({
  semantic: z.string().optional().nullable(),
  fulltext: z.string().optional().nullable(),
  grep: z.string().optional().nullable(),
  tree: treeFilterSchema.optional().nullable(),
  meta: metaSchema.optional().nullable(),
  temporal: temporalFilterSchema.optional().nullable(),
  limit: z.number().int().min(1).max(1000).optional(),
  candidateLimit: z.number().int().min(1).max(1000).optional(),
  semanticThreshold: z.number().min(0).max(1).optional().nullable(),
  weights: searchWeightsSchema.optional().nullable(),
  orderBy: z.enum(["asc", "desc"]).optional(),
});

export type MemorySearchParams = z.infer<typeof memorySearchParams>;

/**
 * memory.tree params.
 */
export const memoryTreeParams = z.object({
  tree: treePathSchema.optional().nullable(),
  levels: z.number().int().min(1).max(100).optional(),
});

export type MemoryTreeParams = z.infer<typeof memoryTreeParams>;

/**
 * memory.copy params.
 */
export const memoryCopyParams = z.object({
  source: treePathSchema.min(1, "source path is required"),
  destination: treePathSchema.min(1, "destination path is required"),
  dryRun: z.boolean().optional(),
});

export type MemoryCopyParams = z.infer<typeof memoryCopyParams>;

/**
 * memory.move params.
 */
export const memoryMoveParams = z.object({
  source: treePathSchema.min(1, "source path is required"),
  destination: treePathSchema,
  dryRun: z.boolean().optional(),
});

export type MemoryMoveParams = z.infer<typeof memoryMoveParams>;

/**
 * memory.deleteTree params.
 */
export const memoryDeleteTreeParams = z.object({
  tree: treePathSchema.min(1, "tree path is required"),
  dryRun: z.boolean().optional(),
});

export type MemoryDeleteTreeParams = z.infer<typeof memoryDeleteTreeParams>;

/**
 * memory.countTree params.
 */
export const memoryCountTreeParams = z.object({
  tree: treeFilterSchema.min(1, "tree filter is required"),
  maxCount: z.number().int().min(1).optional(),
});

export type MemoryCountTreeParams = z.infer<typeof memoryCountTreeParams>;

/**
 * memory.embeddingStatus params — no arguments (space-wide backlog snapshot).
 */
export const memoryEmbeddingStatusParams = z.object({});

export type MemoryEmbeddingStatusParams = z.infer<
  typeof memoryEmbeddingStatusParams
>;

/**
 * memory.deleteOrphansInTree params — delete the orphans of an
 * importer-maintained subtree: every NAMED row under `root` matching
 * `metaContains` whose `(tree, name)` slot is not in `keep`. `metaContains`
 * must be a non-empty object (the ownership stamp, e.g. `{source: "docs"}`)
 * so an unscoped "delete everything not in my list" cannot be expressed.
 * `dryRun` returns the would-delete paths without deleting.
 */
export const memoryDeleteOrphansInTreeParams = z.object({
  root: treePathSchema.min(1, "root path is required"),
  metaContains: metaSchema.refine((m) => Object.keys(m).length > 0, {
    message: "metaContains must be a non-empty object",
  }),
  keep: z
    .array(
      z.object({
        tree: treePathSchema.min(1, "tree path is required"),
        name: memoryNameSchema,
      }),
    )
    // The server's 1 MiB request-body cap is the binding limit — a realistic
    // keep-list larger than this cannot fit under it anyway. The count
    // ceiling exists so a tiny-slot overflow that DOES fit fails as a clear
    // VALIDATION_ERROR rather than sailing through.
    .max(25_000),
  dryRun: z.boolean().optional(),
});

export type MemoryDeleteOrphansInTreeParams = z.infer<
  typeof memoryDeleteOrphansInTreeParams
>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single memory response — returned by create, get, update.
 */
export const memoryResponse = z.object({
  id: z.string(),
  content: z.string(),
  meta: z.record(z.string(), z.unknown()),
  tree: z.string(),
  name: z.string().nullable(),
  temporal: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .nullable(),
  version: z.number().int().positive(),
  versionHash: z.string().length(32),
  hasEmbedding: z.boolean(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type MemoryResponse = z.infer<typeof memoryResponse>;

/**
 * Memory with search score — used in search results.
 */
export const memoryWithScoreResponse = memoryResponse.extend({
  score: z.number(),
});

export type MemoryWithScoreResponse = z.infer<typeof memoryWithScoreResponse>;

/**
 * One row's outcome from create/batchCreate: its stored `id` (the kept existing
 * id on a (tree, name) update/skip — readable even when skipped) and `status`
 * ('inserted' | 'updated' | 'skipped').
 */
export const memoryWriteResult = z.object({
  id: z.string(),
  status: writeStatusSchema,
});

export type MemoryWriteResult = z.infer<typeof memoryWriteResult>;

/**
 * memory.append result — compact; never carries the memory body. `appendedBytes`
 * is the UTF-8 size of the separator + appended text; `contentLength` is the
 * character length (Unicode code points, matching PostgreSQL `length(text)`)
 * after the append; `replayed` is true when an operation-key match replayed a
 * prior append instead of writing again. Like the sibling result schemas this
 * is a plain (non-strict) object — an unexpected key is stripped, not rejected —
 * so an accidental body field cannot survive into the compact result.
 */
export const memoryAppendResult = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  versionHash: z.string().length(32),
  appendedBytes: z.number().int().nonnegative(),
  contentLength: z.number().int().nonnegative(),
  replayed: z.boolean(),
});

export type MemoryAppendResult = z.infer<typeof memoryAppendResult>;

/**
 * memory.batchCreate result.
 *
 * `results` carries one entry per submitted memory, in request order (so
 * `results[i]` is the outcome of `memories[i]`). Each is `{ id, status }`:
 * `inserted` (new row), `updated` (existing row rewritten by `onConflict:
 * 'replace'`), or `skipped` (already existed and nothing differed, or
 * `onConflict: 'ignore'`). Derive inserted/updated/skipped sets by filtering on
 * `status`.
 */
export const memoryBatchCreateResult = z.object({
  results: z.array(memoryWriteResult),
});

export type MemoryBatchCreateResult = z.infer<typeof memoryBatchCreateResult>;

/**
 * memory.delete result.
 */
export const memoryDeleteResult = z.object({
  deleted: z.boolean(),
});

export type MemoryDeleteResult = z.infer<typeof memoryDeleteResult>;

/**
 * memory.search result.
 */
export const memorySearchResult = z.object({
  results: z.array(memoryWithScoreResponse),
  total: z.number(),
  limit: z.number(),
});

export type MemorySearchResult = z.infer<typeof memorySearchResult>;

/**
 * Tree node — used in memory.tree result.
 */
export const treeNodeResponse = z.object({
  path: z.string(),
  count: z.number().int(),
});

export type TreeNodeResponse = z.infer<typeof treeNodeResponse>;

/**
 * memory.tree result.
 */
export const memoryTreeResult = z.object({
  nodes: z.array(treeNodeResponse),
});

export type MemoryTreeResult = z.infer<typeof memoryTreeResult>;

/**
 * memory.copy result.
 */
export const memoryCopyResult = z.object({
  count: z.number().int(),
});

export type MemoryCopyResult = z.infer<typeof memoryCopyResult>;

/**
 * memory.move result.
 */
export const memoryMoveResult = z.object({
  count: z.number().int(),
});

export type MemoryMoveResult = z.infer<typeof memoryMoveResult>;

/**
 * memory.deleteTree result.
 */
export const memoryDeleteTreeResult = z.object({
  count: z.number().int(),
});

export type MemoryDeleteTreeResult = z.infer<typeof memoryDeleteTreeResult>;

/**
 * memory.deleteOrphansInTree result — the affected (deleted, or with dryRun
 * would-delete) rows as display paths, plus their count.
 */
export const memoryDeleteOrphansInTreeResult = z.object({
  count: z.number().int(),
  paths: z.array(z.string()),
});

export type MemoryDeleteOrphansInTreeResult = z.infer<
  typeof memoryDeleteOrphansInTreeResult
>;

/**
 * memory.countTree result.
 */
export const memoryCountTreeResult = z.object({
  count: z.number().int(),
});

export type MemoryCountTreeResult = z.infer<typeof memoryCountTreeResult>;

/**
 * memory.embeddingStatus result — a space-wide embedding backlog snapshot.
 *
 * Embedding is fully async (creates write `embedding IS NULL`, a trigger
 * enqueues, an in-process worker pool drains). These counts let a caller see
 * progress after a large import. `pending` = `inFlight` + `waiting`.
 */
export const memoryEmbeddingStatusResult = z.object({
  /** Rows awaiting embedding (in-flight + waiting). */
  pending: z.number().int(),
  /** Pending rows currently claimed by a worker. */
  inFlight: z.number().int(),
  /** Pending rows claimable now (not yet picked up). */
  waiting: z.number().int(),
  /** Terminal failures still within the prune retention window. */
  failed: z.number().int(),
  /** Enqueue time (ISO) of the oldest pending row; null when the queue is idle. */
  oldestPendingAt: z.string().nullable(),
});

export type MemoryEmbeddingStatusResult = z.infer<
  typeof memoryEmbeddingStatusResult
>;
