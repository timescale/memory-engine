/**
 * Engine RPC API key methods.
 *
 * Implements:
 * - apiKey.create: Create a new API key (returns raw key once)
 * - apiKey.get: Get API key metadata by ID
 * - apiKey.list: List API keys for a user
 * - apiKey.revoke: Revoke an API key
 * - apiKey.delete: Permanently delete an API key
 */
import type { ApiKey } from "@memory-engine/engine";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  type ApiKeyCreateParams,
  type ApiKeyDeleteParams,
  type ApiKeyGetParams,
  type ApiKeyListParams,
  type ApiKeyRevokeParams,
  apiKeyCreateSchema,
  apiKeyDeleteSchema,
  apiKeyGetSchema,
  apiKeyListSchema,
  apiKeyRevokeSchema,
} from "./schemas";
import { assertEngineContext, type EngineContext } from "./types";

// =============================================================================
// Response Types
// =============================================================================

/**
 * API key response (serializable, no secret).
 */
interface ApiKeyResponse {
  id: string;
  userId: string;
  lookupId: string;
  name: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * Convert an ApiKey to a serializable response.
 */
function toApiKeyResponse(apiKey: ApiKey): ApiKeyResponse {
  return {
    id: apiKey.id,
    userId: apiKey.userId,
    lookupId: apiKey.lookupId,
    name: apiKey.name,
    expiresAt: apiKey.expiresAt?.toISOString() ?? null,
    lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    createdAt: apiKey.createdAt.toISOString(),
    revokedAt: apiKey.revokedAt?.toISOString() ?? null,
  };
}

/**
 * API key create response (includes raw key).
 */
interface ApiKeyCreateResponse {
  apiKey: ApiKeyResponse;
  /** The raw API key - only returned on creation, store securely! */
  rawKey: string;
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * apiKey.create - Create a new API key.
 * Returns the raw key once - it cannot be retrieved again.
 */
async function apiKeyCreate(
  params: ApiKeyCreateParams,
  context: HandlerContext,
): Promise<ApiKeyCreateResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const result = await db.createApiKey({
    userId: params.userId,
    name: params.name,
    expiresAt: params.expiresAt ? new Date(params.expiresAt) : undefined,
  });

  return {
    apiKey: toApiKeyResponse(result.apiKey),
    rawKey: result.rawKey,
  };
}

/**
 * apiKey.get - Get API key metadata by ID.
 */
async function apiKeyGet(
  params: ApiKeyGetParams,
  context: HandlerContext,
): Promise<ApiKeyResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const apiKey = await db.getApiKey(params.id);
  if (!apiKey) {
    throw new AppError("NOT_FOUND", `API key not found: ${params.id}`);
  }

  return toApiKeyResponse(apiKey);
}

/**
 * apiKey.list - List API keys for a user.
 */
async function apiKeyList(
  params: ApiKeyListParams,
  context: HandlerContext,
): Promise<{ apiKeys: ApiKeyResponse[] }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const apiKeys = await db.listApiKeys(params.userId);
  return { apiKeys: apiKeys.map(toApiKeyResponse) };
}

/**
 * apiKey.revoke - Revoke an API key (soft delete).
 */
async function apiKeyRevoke(
  params: ApiKeyRevokeParams,
  context: HandlerContext,
): Promise<{ revoked: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const revoked = await db.revokeApiKey(params.id);
  if (!revoked) {
    throw new AppError(
      "NOT_FOUND",
      `API key not found or already revoked: ${params.id}`,
    );
  }

  return { revoked };
}

/**
 * apiKey.delete - Permanently delete an API key.
 */
async function apiKeyDelete(
  params: ApiKeyDeleteParams,
  context: HandlerContext,
): Promise<{ deleted: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const deleted = await db.deleteApiKey(params.id);
  if (!deleted) {
    throw new AppError("NOT_FOUND", `API key not found: ${params.id}`);
  }

  return { deleted };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the API key methods registry.
 */
export const apiKeyMethods = buildRegistry()
  .register("apiKey.create", apiKeyCreateSchema, apiKeyCreate)
  .register("apiKey.get", apiKeyGetSchema, apiKeyGet)
  .register("apiKey.list", apiKeyListSchema, apiKeyList)
  .register("apiKey.revoke", apiKeyRevokeSchema, apiKeyRevoke)
  .register("apiKey.delete", apiKeyDeleteSchema, apiKeyDelete)
  .build();
