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
