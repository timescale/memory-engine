/**
 * Api key method schemas (apiKey.*).
 *
 * Keys are agent-only (humans authenticate via session) and global per-principal
 * — not bound to a space. The plaintext key is returned exactly once, by
 * apiKey.create. There is no soft-revoke state: apiKey.delete is the only
 * removal (revoke ≡ delete).
 */
import { z } from "zod";
import { nameSchema, timestampSchema, uuidv7Schema } from "../fields.ts";

export const apiKeyInfoResponse = z.object({
  id: z.string(),
  memberId: z.string(),
  lookupId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type ApiKeyInfoResponse = z.infer<typeof apiKeyInfoResponse>;

// apiKey.create — mint a key for an agent the caller owns
export const apiKeyCreateParams = z.object({
  agentId: uuidv7Schema,
  name: nameSchema,
  expiresAt: timestampSchema.optional().nullable(),
});
export type ApiKeyCreateParams = z.infer<typeof apiKeyCreateParams>;

export const apiKeyCreateResult = z.object({
  id: z.string(),
  /** The full api key string — returned once; only its hash is stored. */
  key: z.string(),
});
export type ApiKeyCreateResult = z.infer<typeof apiKeyCreateResult>;

// apiKey.list — a member's keys (metadata only)
export const apiKeyListParams = z.object({ memberId: uuidv7Schema });
export type ApiKeyListParams = z.infer<typeof apiKeyListParams>;

export const apiKeyListResult = z.object({
  apiKeys: z.array(apiKeyInfoResponse),
});
export type ApiKeyListResult = z.infer<typeof apiKeyListResult>;

// apiKey.get
export const apiKeyGetParams = z.object({ id: uuidv7Schema });
export type ApiKeyGetParams = z.infer<typeof apiKeyGetParams>;

export const apiKeyGetResult = z.object({
  apiKey: apiKeyInfoResponse.nullable(),
});
export type ApiKeyGetResult = z.infer<typeof apiKeyGetResult>;

// apiKey.delete (revoke ≡ delete)
export const apiKeyDeleteParams = z.object({ id: uuidv7Schema });
export type ApiKeyDeleteParams = z.infer<typeof apiKeyDeleteParams>;

export const apiKeyDeleteResult = z.object({ deleted: z.boolean() });
export type ApiKeyDeleteResult = z.infer<typeof apiKeyDeleteResult>;
