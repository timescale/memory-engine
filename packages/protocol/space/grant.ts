/**
 * Tree-access grant method schemas (grant.*).
 *
 * The core model uses three additive levels (1 = read, 2 = write, 3 = owner);
 * there are no per-action grants and no deny entries. Owner listing is grant.list
 * filtered to access = 3.
 */
import { z } from "zod";
import { treePathSchema, uuidv7Schema } from "../fields.ts";

/** Access level: 1 = read, 2 = write, 3 = owner. */
export const accessLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type AccessLevel = z.infer<typeof accessLevelSchema>;

export const treeGrantResponse = z.object({
  principalId: z.string(),
  treePath: z.string(),
  access: accessLevelSchema,
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type TreeGrantResponse = z.infer<typeof treeGrantResponse>;

// grant.set — grant or update a principal's access at a tree path
export const grantSetParams = z.object({
  principalId: uuidv7Schema,
  treePath: treePathSchema,
  access: accessLevelSchema,
});
export type GrantSetParams = z.infer<typeof grantSetParams>;

export const grantSetResult = z.object({ granted: z.boolean() });
export type GrantSetResult = z.infer<typeof grantSetResult>;

// grant.remove
export const grantRemoveParams = z.object({
  principalId: uuidv7Schema,
  treePath: treePathSchema,
});
export type GrantRemoveParams = z.infer<typeof grantRemoveParams>;

export const grantRemoveResult = z.object({ removed: z.boolean() });
export type GrantRemoveResult = z.infer<typeof grantRemoveResult>;

// grant.list — optionally filtered to a principal and/or a subtree path
export const grantListParams = z.object({
  principalId: uuidv7Schema.optional().nullable(),
  /** Only grants at or below this tree path (requires owning the path). */
  treePath: treePathSchema.optional().nullable(),
});
export type GrantListParams = z.infer<typeof grantListParams>;

export const grantListResult = z.object({
  grants: z.array(treeGrantResponse),
});
export type GrantListResult = z.infer<typeof grantListResult>;
