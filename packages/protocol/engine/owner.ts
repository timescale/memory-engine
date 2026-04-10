/**
 * Owner method schemas — params and results for owner.* RPC methods.
 */
import { z } from "zod";
import { treePathSchema, uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * owner.set params.
 */
export const ownerSetParams = z.object({
  userId: uuidv7Schema,
  treePath: treePathSchema,
});

export type OwnerSetParams = z.infer<typeof ownerSetParams>;

/**
 * owner.remove params.
 */
export const ownerRemoveParams = z.object({
  treePath: treePathSchema,
});

export type OwnerRemoveParams = z.infer<typeof ownerRemoveParams>;

/**
 * owner.get params.
 */
export const ownerGetParams = z.object({
  treePath: treePathSchema,
});

export type OwnerGetParams = z.infer<typeof ownerGetParams>;

/**
 * owner.list params.
 */
export const ownerListParams = z.object({
  userId: uuidv7Schema.optional(),
});

export type OwnerListParams = z.infer<typeof ownerListParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single owner response.
 */
export const ownerResponse = z.object({
  treePath: z.string(),
  userId: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

export type OwnerResponse = z.infer<typeof ownerResponse>;

/**
 * owner.set result.
 */
export const ownerSetResult = z.object({
  set: z.boolean(),
});

export type OwnerSetResult = z.infer<typeof ownerSetResult>;

/**
 * owner.remove result.
 */
export const ownerRemoveResult = z.object({
  removed: z.boolean(),
});

export type OwnerRemoveResult = z.infer<typeof ownerRemoveResult>;

/**
 * owner.list result.
 */
export const ownerListResult = z.object({
  owners: z.array(ownerResponse),
});

export type OwnerListResult = z.infer<typeof ownerListResult>;
