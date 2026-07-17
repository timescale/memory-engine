/**
 * Api key method schemas (apiKey.*).
 *
 * A key is minted for a credential-bearing member the caller may administer:
 * an agent, a service account, or the caller's OWN user principal (a personal
 * access token for headless/CLI use).
 * Keys are global per-principal (not space-bound). The plaintext key is returned
 * exactly once, by apiKey.create. There is no soft-revoke state: apiKey.delete
 * is the only removal (revoke ≡ delete). Minting/deleting keys is session-only —
 * a key can't manage keys (see authenticate-user).
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
  lastUsedOn: z.string().nullable(),
});
export type ApiKeyInfoResponse = z.infer<typeof apiKeyInfoResponse>;

// apiKey.create — mint a key for a member the caller may administer: their own
// user principal (a PAT), an owned agent, or a service account. `memberId` is
// always explicit.
export const apiKeyCreateParams = z.object({
  memberId: uuidv7Schema,
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
