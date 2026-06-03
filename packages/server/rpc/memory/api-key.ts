/**
 * Api key handlers (apiKey.*). Keys are agent-only and self-service: the caller
 * manages keys for agents they own. The plaintext key is returned once by
 * create. Revoke ≡ delete (no soft-revoke state).
 */
import { formatApiKey } from "@memory.build/engine/core";
import type {
  ApiKeyCreateParams,
  ApiKeyCreateResult,
  ApiKeyDeleteParams,
  ApiKeyDeleteResult,
  ApiKeyGetParams,
  ApiKeyGetResult,
  ApiKeyListParams,
  ApiKeyListResult,
} from "@memory.build/protocol/space";
import {
  apiKeyCreateParams,
  apiKeyDeleteParams,
  apiKeyGetParams,
  apiKeyListParams,
} from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { guardCore, requireOwnedAgent, toApiKeyInfoResponse } from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

async function apiKeyCreate(
  params: ApiKeyCreateParams,
  context: HandlerContext,
): Promise<ApiKeyCreateResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // Keys are agent-only; the caller must own the agent (which is in this space).
  await requireOwnedAgent(ctx, params.agentId);

  const created = await guardCore(() =>
    ctx.core.createApiKey(params.agentId, params.name, {
      expiresAt: params.expiresAt ? new Date(params.expiresAt) : undefined,
    }),
  );
  // The full key string embeds the space slug for routing; returned once.
  const key = formatApiKey(ctx.space.slug, created.lookupId, created.secret);
  return { id: created.id, key };
}

async function apiKeyList(
  params: ApiKeyListParams,
  context: HandlerContext,
): Promise<ApiKeyListResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  await requireOwnedAgent(ctx, params.memberId);
  const keys = await ctx.core.listApiKeys(params.memberId);
  return { apiKeys: keys.map(toApiKeyInfoResponse) };
}

async function apiKeyGet(
  params: ApiKeyGetParams,
  context: HandlerContext,
): Promise<ApiKeyGetResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const key = await ctx.core.getApiKey(params.id);
  if (!key) return { apiKey: null };
  // Only the owning user of the key's agent may see it.
  await requireOwnedAgent(ctx, key.memberId);
  return { apiKey: toApiKeyInfoResponse(key) };
}

async function apiKeyDelete(
  params: ApiKeyDeleteParams,
  context: HandlerContext,
): Promise<ApiKeyDeleteResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const key = await ctx.core.getApiKey(params.id);
  if (!key) return { deleted: false };
  await requireOwnedAgent(ctx, key.memberId);
  const deleted = await guardCore(() => ctx.core.deleteApiKey(params.id));
  return { deleted };
}

export const apiKeyMethods = buildRegistry()
  .register("apiKey.create", apiKeyCreateParams, apiKeyCreate)
  .register("apiKey.list", apiKeyListParams, apiKeyList)
  .register("apiKey.get", apiKeyGetParams, apiKeyGet)
  .register("apiKey.delete", apiKeyDeleteParams, apiKeyDelete)
  .build();
