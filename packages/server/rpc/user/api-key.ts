/**
 * Api key handlers (apiKey.*) for the user RPC.
 *
 * The caller manages keys for a member they own — an agent, or their OWN user
 * principal (a personal access token). Keys are global per-principal (not
 * space-bound). The plaintext key is returned once by create. Revoke ≡ delete.
 * Minting/revoking is session-only (`denyApiKeyCaller`): a key can't manage keys.
 */
import type { ApiKeyInfo } from "@memory.build/engine/core";
import { formatApiKey } from "@memory.build/engine/core";
import type {
  ApiKeyCreateParams,
  ApiKeyCreateResult,
  ApiKeyDeleteParams,
  ApiKeyDeleteResult,
  ApiKeyGetParams,
  ApiKeyGetResult,
  ApiKeyInfoResponse,
  ApiKeyListParams,
  ApiKeyListResult,
} from "@memory.build/protocol/user";
import {
  apiKeyCreateParams,
  apiKeyDeleteParams,
  apiKeyGetParams,
  apiKeyListParams,
} from "@memory.build/protocol/user";
import { guardCore } from "../core-error";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { requireOwnMember } from "./agent";
import { assertUserRpcContext, type UserRpcContext } from "./types";

/**
 * Reject key-authenticated callers from the credential-management ops. A user
 * PAT can drive the rest of the user RPC, but it must not mint or revoke keys —
 * that would let a leaked key persist past revocation (mint a sibling) or lock
 * the owner out (delete their others). Minting/revoking stays session-only.
 */
function denyApiKeyCaller(ctx: UserRpcContext): void {
  if (ctx.viaApiKey) {
    throw new AppError(
      "FORBIDDEN",
      "API keys can't manage API keys — run `me login` (session) to mint or revoke keys.",
    );
  }
}

function toApiKeyInfoResponse(k: ApiKeyInfo): ApiKeyInfoResponse {
  return {
    id: k.id,
    memberId: k.memberId,
    lookupId: k.lookupId,
    name: k.name,
    createdAt: k.createdAt.toISOString(),
    expiresAt: k.expiresAt?.toISOString() ?? null,
  };
}

async function apiKeyCreate(
  params: ApiKeyCreateParams,
  context: HandlerContext,
): Promise<ApiKeyCreateResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  denyApiKeyCaller(ctx); // keys can't mint keys
  // The member must be the caller's own user principal (a PAT) or an owned agent.
  await requireOwnMember(ctx, params.memberId);

  const created = await guardCore(() =>
    ctx.core.createApiKey(params.memberId, params.name, {
      expiresAt: params.expiresAt ? new Date(params.expiresAt) : undefined,
    }),
  );
  // The full key string is global (no space slug); returned once.
  const key = formatApiKey(created.lookupId, created.secret);
  return { id: created.id, key };
}

async function apiKeyList(
  params: ApiKeyListParams,
  context: HandlerContext,
): Promise<ApiKeyListResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireOwnMember(ctx, params.memberId);
  const keys = await ctx.core.listApiKeys(params.memberId);
  return { apiKeys: keys.map(toApiKeyInfoResponse) };
}

async function apiKeyGet(
  params: ApiKeyGetParams,
  context: HandlerContext,
): Promise<ApiKeyGetResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const key = await ctx.core.getApiKey(params.id);
  if (!key) return { apiKey: null };
  // Only the member's owner may see it (the caller themselves, or an owned agent).
  await requireOwnMember(ctx, key.memberId);
  return { apiKey: toApiKeyInfoResponse(key) };
}

async function apiKeyDelete(
  params: ApiKeyDeleteParams,
  context: HandlerContext,
): Promise<ApiKeyDeleteResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  denyApiKeyCaller(ctx); // keys can't revoke keys
  const key = await ctx.core.getApiKey(params.id);
  if (!key) return { deleted: false };
  await requireOwnMember(ctx, key.memberId);
  const deleted = await guardCore(() => ctx.core.deleteApiKey(params.id));
  return { deleted };
}

export const apiKeyMethods = buildRegistry()
  .register("apiKey.create", apiKeyCreateParams, apiKeyCreate)
  .register("apiKey.list", apiKeyListParams, apiKeyList)
  .register("apiKey.get", apiKeyGetParams, apiKeyGet)
  .register("apiKey.delete", apiKeyDeleteParams, apiKeyDelete)
  .build();
