/**
 * Memory method schemas — params and results for memory.* RPC methods.
 */
import { z } from "zod";
import {
  metaSchema,
  searchWeightsSchema,
  temporalFilterSchema,
  temporalSchema,
  treeFilterSchema,
  treePathSchema,
  uuidv7Schema,
} from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * memory.create params.
 */
export const memoryCreateParams = z.object({
  id: uuidv7Schema.optional().nullable(),
  content: z.string().min(1, "content is required"),
  meta: metaSchema.optional().nullable(),
  tree: treePathSchema.optional().nullable(),
  temporal: temporalSchema.optional().nullable(),
});

export type MemoryCreateParams = z.infer<typeof memoryCreateParams>;

/**
 * memory.batchCreate params.
 */
export const memoryBatchCreateParams = z.object({
  memories: z
    .array(
      z.object({
        id: uuidv7Schema.optional().nullable(),
        content: z.string().min(1, "content is required"),
        meta: metaSchema.optional().nullable(),
        tree: treePathSchema.optional().nullable(),
        temporal: temporalSchema.optional().nullable(),
      }),
    )
    .min(1, "at least one memory required")
    .max(1000, "maximum 1000 memories per batch"),
});

export type MemoryBatchCreateParams = z.infer<typeof memoryBatchCreateParams>;

/**
 * memory.get params.
 */
export const memoryGetParams = z.object({
  id: uuidv7Schema,
});

export type MemoryGetParams = z.infer<typeof memoryGetParams>;

/**
 * memory.update params.
 */
export const memoryUpdateParams = z.object({
  id: uuidv7Schema,
  content: z.string().min(1).optional().nullable(),
  meta: metaSchema.optional().nullable(),
  tree: treePathSchema.optional().nullable(),
  temporal: temporalSchema.optional().nullable(),
});

export type MemoryUpdateParams = z.infer<typeof memoryUpdateParams>;

/**
 * memory.delete params.
 */
export const memoryDeleteParams = z.object({
  id: uuidv7Schema,
});

export type MemoryDeleteParams = z.infer<typeof memoryDeleteParams>;

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
  tree: treePathSchema.min(1, "tree path is required"),
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
 */
export const memoryBatchCreateResult = z.object({
  ids: z.array(z.string()),
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
