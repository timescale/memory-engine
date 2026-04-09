/**
 * Org method schemas — params and results for org.* RPC methods.
 */
import { z } from "zod";
import { nameSchema, slugSchema, uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * org.create params.
 */
export const orgCreateParams = z.object({
  slug: slugSchema,
  name: nameSchema,
});

export type OrgCreateParams = z.infer<typeof orgCreateParams>;

/**
 * org.list params — no params needed, lists orgs for session identity.
 */
export const orgListParams = z.object({});

export type OrgListParams = z.infer<typeof orgListParams>;

/**
 * org.get params.
 */
export const orgGetParams = z.object({
  id: uuidv7Schema,
});

export type OrgGetParams = z.infer<typeof orgGetParams>;

/**
 * org.update params.
 */
export const orgUpdateParams = z.object({
  id: uuidv7Schema,
  name: nameSchema.optional(),
  slug: slugSchema.optional(),
});

export type OrgUpdateParams = z.infer<typeof orgUpdateParams>;

/**
 * org.delete params.
 */
export const orgDeleteParams = z.object({
  id: uuidv7Schema,
});

export type OrgDeleteParams = z.infer<typeof orgDeleteParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single org response — returned by create, get, update.
 */
export const orgResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type OrgResponse = z.infer<typeof orgResponse>;

/**
 * org.list result.
 */
export const orgListResult = z.object({
  orgs: z.array(orgResponse),
});

export type OrgListResult = z.infer<typeof orgListResult>;

/**
 * org.delete result.
 */
export const orgDeleteResult = z.object({
  deleted: z.boolean(),
});

export type OrgDeleteResult = z.infer<typeof orgDeleteResult>;
