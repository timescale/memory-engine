/**
 * Grant method schemas — params and results for grant.* RPC methods.
 */
import { z } from "zod";
import { grantActionSchema, treePathSchema, uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * grant.create params.
 */
export const grantCreateParams = z.object({
  userId: uuidv7Schema,
  treePath: treePathSchema,
  actions: z.array(grantActionSchema).min(1, "at least one action required"),
  withGrantOption: z.boolean().optional(),
});

export type GrantCreateParams = z.infer<typeof grantCreateParams>;

/**
 * grant.list params.
 */
export const grantListParams = z.object({
  userId: uuidv7Schema.optional(),
});

export type GrantListParams = z.infer<typeof grantListParams>;

/**
 * grant.get params.
 */
export const grantGetParams = z.object({
  userId: uuidv7Schema,
  treePath: treePathSchema,
});

export type GrantGetParams = z.infer<typeof grantGetParams>;

/**
 * grant.revoke params.
 */
export const grantRevokeParams = z.object({
  userId: uuidv7Schema,
  treePath: treePathSchema,
});

export type GrantRevokeParams = z.infer<typeof grantRevokeParams>;

/**
 * grant.check params.
 */
export const grantCheckParams = z.object({
  userId: uuidv7Schema,
  treePath: treePathSchema,
  action: grantActionSchema,
});

export type GrantCheckParams = z.infer<typeof grantCheckParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single grant response — returned by get.
 */
export const grantResponse = z.object({
  id: z.string(),
  userId: z.string(),
  treePath: z.string(),
  actions: z.array(z.string()),
  grantedBy: z.string().nullable(),
  withGrantOption: z.boolean(),
  createdAt: z.string(),
});

export type GrantResponse = z.infer<typeof grantResponse>;

/**
 * grant.create result.
 */
export const grantCreateResult = z.object({
  created: z.boolean(),
});

export type GrantCreateResult = z.infer<typeof grantCreateResult>;

/**
 * grant.list result.
 */
export const grantListResult = z.object({
  grants: z.array(grantResponse),
});

export type GrantListResult = z.infer<typeof grantListResult>;

/**
 * grant.revoke result.
 */
export const grantRevokeResult = z.object({
  revoked: z.boolean(),
});

export type GrantRevokeResult = z.infer<typeof grantRevokeResult>;

/**
 * grant.check result.
 */
export const grantCheckResult = z.object({
  allowed: z.boolean(),
});

export type GrantCheckResult = z.infer<typeof grantCheckResult>;
