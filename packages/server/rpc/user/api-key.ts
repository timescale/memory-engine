/**
 * Api key handlers (apiKey.*) for the user RPC.
 *
 * Keys are agent-only and self-service: the caller manages keys for agents they
 * own. Keys are global per-principal (not space-bound) — the same key works in
 * any space the agent is admitted to. The plaintext key is returned once by
 * create. Revoke ≡ delete (no soft-revoke state).
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
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { requireOwnAgent } from "./agent";
import { assertUserRpcContext, type UserRpcContext } from "./types";

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
  // Keys are agent-only; the caller must own the agent (checked globally).
  await requireOwnAgent(ctx, params.agentId);

  const created = await guardCore(() =>
    ctx.core.createApiKey(params.agentId, params.name, {
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
  await requireOwnAgent(ctx, params.memberId);
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
  // Only the owning user of the key's agent may see it.
  await requireOwnAgent(ctx, key.memberId);
  return { apiKey: toApiKeyInfoResponse(key) };
}

async function apiKeyDelete(
  params: ApiKeyDeleteParams,
  context: HandlerContext,
): Promise<ApiKeyDeleteResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const key = await ctx.core.getApiKey(params.id);
  if (!key) return { deleted: false };
  await requireOwnAgent(ctx, key.memberId);
  const deleted = await guardCore(() => ctx.core.deleteApiKey(params.id));
  return { deleted };
}

export const apiKeyMethods = buildRegistry()
  .register("apiKey.create", apiKeyCreateParams, apiKeyCreate)
  .register("apiKey.list", apiKeyListParams, apiKeyList)
  .register("apiKey.get", apiKeyGetParams, apiKeyGet)
  .register("apiKey.delete", apiKeyDeleteParams, apiKeyDelete)
  .build();
