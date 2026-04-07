/**
 * Zod schemas for Engine RPC methods.
 *
 * These schemas define the expected params for each method.
 * Zod 4 compatible.
 */
import { z } from "zod";

// =============================================================================
// Common Schemas
// =============================================================================

/**
 * UUID v7 schema using Zod 4's native uuidv7 support.
 */
export const uuidv7Schema = z.uuidv7();

/**
 * ltree path pattern (alphanumeric and underscores, dot-separated).
 */
const ltreePattern = /^([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)?$/;

/**
 * Tree path schema (ltree format, allows empty string for root).
 */
export const treePathSchema = z
  .string()
  .regex(
    ltreePattern,
    "must be a valid ltree path (alphanumeric/underscore, dot-separated)",
  );

/**
 * Tree filter schema (ltree, lquery, or ltxtquery).
 * More permissive than treePathSchema since it allows query operators.
 */
export const treeFilterSchema = z.string().min(1);

/**
 * ISO 8601 timestamp string.
 */
export const timestampSchema = z.string().datetime({ offset: true });

/**
 * Temporal range schema for create/update.
 */
export const temporalSchema = z.object({
  start: timestampSchema,
  end: z.union([timestampSchema, z.null()]).optional(),
});

/**
 * Temporal filter for search.
 */
export const temporalFilterSchema = z.object({
  contains: timestampSchema.optional(),
  overlaps: z
    .object({
      start: timestampSchema,
      end: timestampSchema,
    })
    .optional(),
  within: z
    .object({
      start: timestampSchema,
      end: timestampSchema,
    })
    .optional(),
});

/**
 * Metadata schema (arbitrary JSON object).
 */
export const metaSchema = z.record(z.string(), z.unknown());

/**
 * Search weights schema.
 */
export const searchWeightsSchema = z.object({
  semantic: z.number().min(0).max(1).optional(),
  fulltext: z.number().min(0).max(1).optional(),
});

// =============================================================================
// Memory Method Schemas
// =============================================================================

/**
 * memory.create params.
 */
export const memoryCreateSchema = z.object({
  id: uuidv7Schema.optional().nullable(),
  content: z.string().min(1, "content is required"),
  meta: metaSchema.optional().nullable(),
  tree: treePathSchema.optional().nullable(),
  temporal: temporalSchema.optional().nullable(),
});

export type MemoryCreateParams = z.infer<typeof memoryCreateSchema>;

/**
 * memory.batchCreate params.
 */
export const memoryBatchCreateSchema = z.object({
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

export type MemoryBatchCreateParams = z.infer<typeof memoryBatchCreateSchema>;

/**
 * memory.get params.
 */
export const memoryGetSchema = z.object({
  id: uuidv7Schema,
});

export type MemoryGetParams = z.infer<typeof memoryGetSchema>;

/**
 * memory.update params.
 */
export const memoryUpdateSchema = z.object({
  id: uuidv7Schema,
  content: z.string().min(1).optional().nullable(),
  meta: metaSchema.optional().nullable(),
  tree: treePathSchema.optional().nullable(),
  temporal: temporalSchema.optional().nullable(),
});

export type MemoryUpdateParams = z.infer<typeof memoryUpdateSchema>;

/**
 * memory.delete params.
 */
export const memoryDeleteSchema = z.object({
  id: uuidv7Schema,
});

export type MemoryDeleteParams = z.infer<typeof memoryDeleteSchema>;

/**
 * memory.search params.
 */
export const memorySearchSchema = z.object({
  semantic: z.string().optional().nullable(),
  fulltext: z.string().optional().nullable(),
  tree: treeFilterSchema.optional().nullable(),
  meta: metaSchema.optional().nullable(),
  temporal: temporalFilterSchema.optional().nullable(),
  limit: z.number().int().min(1).max(1000).optional(),
  candidateLimit: z.number().int().min(1).max(1000).optional(),
  weights: searchWeightsSchema.optional().nullable(),
  orderBy: z.enum(["asc", "desc"]).optional(),
});

export type MemorySearchParams = z.infer<typeof memorySearchSchema>;

/**
 * memory.tree params.
 */
export const memoryTreeSchema = z.object({
  tree: treePathSchema.optional().nullable(),
  levels: z.number().int().min(1).max(100).optional(),
});

export type MemoryTreeParams = z.infer<typeof memoryTreeSchema>;

/**
 * memory.move params.
 */
export const memoryMoveSchema = z.object({
  source: treePathSchema.min(1, "source path is required"),
  destination: treePathSchema,
});

export type MemoryMoveParams = z.infer<typeof memoryMoveSchema>;

/**
 * memory.deleteTree params.
 */
export const memoryDeleteTreeSchema = z.object({
  tree: treePathSchema.min(1, "tree path is required"),
  dryRun: z.boolean().optional(),
});

export type MemoryDeleteTreeParams = z.infer<typeof memoryDeleteTreeSchema>;
