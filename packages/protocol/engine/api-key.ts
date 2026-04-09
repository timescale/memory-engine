/**
 * API Key method schemas — params and results for apiKey.* RPC methods.
 */
import { z } from "zod";
import { timestampSchema, uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * apiKey.create params.
 */
export const apiKeyCreateParams = z.object({
  userId: uuidv7Schema,
  name: z.string().min(1, "name is required"),
  expiresAt: timestampSchema.optional().nullable(),
});

export type ApiKeyCreateParams = z.infer<typeof apiKeyCreateParams>;

/**
 * apiKey.get params.
 */
export const apiKeyGetParams = z.object({
  id: uuidv7Schema,
});

export type ApiKeyGetParams = z.infer<typeof apiKeyGetParams>;

/**
 * apiKey.list params.
 */
export const apiKeyListParams = z.object({
  userId: uuidv7Schema,
});

export type ApiKeyListParams = z.infer<typeof apiKeyListParams>;

/**
 * apiKey.revoke params.
 */
export const apiKeyRevokeParams = z.object({
  id: uuidv7Schema,
});

export type ApiKeyRevokeParams = z.infer<typeof apiKeyRevokeParams>;

/**
 * apiKey.delete params.
 */
export const apiKeyDeleteParams = z.object({
  id: uuidv7Schema,
});

export type ApiKeyDeleteParams = z.infer<typeof apiKeyDeleteParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single API key response — returned by get, included in list and create.
 */
export const apiKeyResponse = z.object({
  id: z.string(),
  userId: z.string(),
  lookupId: z.string(),
  name: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

export type ApiKeyResponse = z.infer<typeof apiKeyResponse>;

/**
 * apiKey.create result — includes the raw key (only returned on creation).
 */
export const apiKeyCreateResult = z.object({
  apiKey: apiKeyResponse,
  rawKey: z.string(),
});

export type ApiKeyCreateResult = z.infer<typeof apiKeyCreateResult>;

/**
 * apiKey.list result.
 */
export const apiKeyListResult = z.object({
  apiKeys: z.array(apiKeyResponse),
});

export type ApiKeyListResult = z.infer<typeof apiKeyListResult>;

/**
 * apiKey.revoke result.
 */
export const apiKeyRevokeResult = z.object({
  revoked: z.boolean(),
});

export type ApiKeyRevokeResult = z.infer<typeof apiKeyRevokeResult>;

/**
 * apiKey.delete result.
 */
export const apiKeyDeleteResult = z.object({
  deleted: z.boolean(),
});

export type ApiKeyDeleteResult = z.infer<typeof apiKeyDeleteResult>;
