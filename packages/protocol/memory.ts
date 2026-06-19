/**
 * Memory method schemas — params and results for memory.* RPC methods.
 */
import { z } from "zod";
import {
  memoryNameSchema,
  metaSchema,
  onConflictSchema,
  searchWeightsSchema,
  temporalFilterSchema,
  temporalSchema,
  treeFilterSchema,
  treePathSchema,
  uuidv7Schema,
} from "./fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * memory.create params.
 *
 * `id` is optional — supply it to preserve identity (import/export, deterministic
 * importers); omit it for a server-generated uuidv7. `name` is the optional leaf
 * slug. `onConflict` governs a clash on the idempotency key (the id when given,
 * else the (tree, name) slot): default `error`.
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
 * `onConflict` governs a clash on each row's idempotency key (its id when given,
 * else its (tree, name) slot): `error` raises, `replace` overwrites in place
 * (a no-op when nothing changed), `ignore` skips. `replaceIfMetaDiffers` is a
 * transitional override naming a meta key for conditional replace: a row is
 * rewritten when the stored row's value for that key differs from the submitted
 * one (deterministic-id importers pass e.g. "importer_version" so version bumps
 * re-render), and skipped when it matches. When set it takes precedence.
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
  replaceIfMetaDiffers: z.string().min(1).optional().nullable(),
});

export type MemoryBatchCreateParams = z.infer<typeof memoryBatchCreateParams>;

/**
 * memory.get params — by id. To address by the `folder/name` form use
 * memory.getByPath.
 */
export const memoryGetParams = z.object({
  id: uuidv7Schema,
});

export type MemoryGetParams = z.infer<typeof memoryGetParams>;

/**
 * memory.getByPath params — address a named memory by its `folder/name` path
 * (e.g. "share/auth/jwt-rotation"). The server splits at the final `/`: the
 * last segment is the name, the rest is the tree (with `~`/separators
 * normalized). NOT_FOUND when no such named memory exists.
 */
export const memoryGetByPathParams = z.object({
  path: treePathSchema.min(1, "path is required"),
});

export type MemoryGetByPathParams = z.infer<typeof memoryGetByPathParams>;

/**
 * memory.update params.
 */
export const memoryUpdateParams = z.object({
  id: uuidv7Schema,
  content: z.string().min(1).optional().nullable(),
  meta: metaSchema.optional().nullable(),
  tree: treePathSchema.optional().nullable(),
  // null clears the name; a string sets/renames; omitted leaves it unchanged.
  name: memoryNameSchema.optional().nullable(),
  temporal: temporalSchema.optional().nullable(),
});

export type MemoryUpdateParams = z.infer<typeof memoryUpdateParams>;

/**
 * memory.delete params — delete one memory by id. (Address a named memory by
 * its path with memory.deleteByPath; delete a whole subtree with deleteTree.)
 */
export const memoryDeleteParams = z.object({
  id: uuidv7Schema,
});

export type MemoryDeleteParams = z.infer<typeof memoryDeleteParams>;

/**
 * memory.deleteByPath params — delete one named memory by its `folder/name`
 * path (split like memory.getByPath). NOT_FOUND when it doesn't resolve.
 */
export const memoryDeleteByPathParams = z.object({
  path: treePathSchema.min(1, "path is required"),
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
 * memory.batchCreate result.
 *
 * `ids` are the freshly inserted memories; `updatedIds` are existing rows
 * rewritten in place via `replaceIfMetaDiffers`. A submitted explicit id in
 * neither array (and not in a failed request) was skipped — it already
 * existed at the same meta-key value.
 */
export const memoryBatchCreateResult = z.object({
  ids: z.array(z.string()),
  updatedIds: z.array(z.string()),
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
 * memory.countTree result.
 */
export const memoryCountTreeResult = z.object({
  count: z.number().int(),
});

export type MemoryCountTreeResult = z.infer<typeof memoryCountTreeResult>;
