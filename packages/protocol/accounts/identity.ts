/**
 * Identity method schemas — params and results for me.* RPC methods.
 */
import { z } from "zod";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * me.get params — no params needed, uses session identity.
 */
export const meGetParams = z.object({});

export type MeGetParams = z.infer<typeof meGetParams>;

/**
 * identity.getByEmail params.
 */
export const identityGetByEmailParams = z.object({
  email: z.string().email(),
});

export type IdentityGetByEmailParams = z.infer<typeof identityGetByEmailParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Identity response — returned by me.get.
 */
export const identityResponse = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type IdentityResponse = z.infer<typeof identityResponse>;

/**
 * identity.getByEmail result — nullable (identity may not exist).
 */
export const identityGetByEmailResult = z.object({
  identity: identityResponse.nullable(),
});

export type IdentityGetByEmailResult = z.infer<typeof identityGetByEmailResult>;
