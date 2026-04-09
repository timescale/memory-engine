/**
 * Session method schemas — params and results for session.* RPC methods.
 */
import { z } from "zod";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * session.revoke params — revokes the current session (logout).
 * No params needed — uses the session from the auth token.
 */
export const sessionRevokeParams = z.object({});

export type SessionRevokeParams = z.infer<typeof sessionRevokeParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * session.revoke result.
 */
export const sessionRevokeResult = z.object({
  revoked: z.boolean(),
});

export type SessionRevokeResult = z.infer<typeof sessionRevokeResult>;
