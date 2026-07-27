/**
 * Api key handlers (apiKey.*) for the user RPC.
 *
 * The caller manages keys for a member they may administer — an agent they own,
 * a service account they administer (a direct user member of its bound admin
 * group, or a space admin), or their OWN user principal (a personal access
 * token). Keys are global per-principal (not space-bound). The plaintext key is
 * returned once by create. Revoke ≡ delete. Minting/revoking is session-only
 * (`denyApiKeyCaller`): a key can't manage keys.
 */
import { normalizeTreePath, TreePathError } from "@memory.build/database";
import type {
  ApiKeyAccess,
  ApiKeyInfo,
  Principal,
} from "@memory.build/engine/core";
import { formatApiKey } from "@memory.build/engine/core";
import type {
  ApiKeyAccessDeclaration,
  ApiKeyAccessResponse,
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
import { requireOwnAgent } from "./agent";
import { requireServiceAccountManager } from "./service-account";
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

async function requireKeyAuthority(
  ctx: UserRpcContext,
  memberId: string,
): Promise<Principal> {
  const principal = await ctx.core.getPrincipal(memberId);
  if (!principal) {
    throw new AppError("NOT_FOUND", `Member not found: ${memberId}`);
  }
  if (memberId === ctx.userId) return principal;

  if (principal.kind === "a") {
    await requireOwnAgent(ctx, memberId);
    return principal;
  }
  if (principal.kind === "s") {
    await requireServiceAccountManager(ctx, memberId);
    return principal;
  }
  // The principal exists (e.g. another user or a group) but the caller may not
  // administer its keys — FORBIDDEN, not NOT_FOUND, so the error isn't misleading.
  throw new AppError(
    "FORBIDDEN",
    `Not authorized to manage API keys for member: ${memberId}`,
  );
}

async function normalizeAccessDeclarations(
  ctx: UserRpcContext,
  target: Principal,
  declarations: ApiKeyAccessDeclaration[] | undefined,
): Promise<ApiKeyAccessDeclaration[] | undefined> {
  if (declarations === undefined) return undefined;
  const normalized = await Promise.all(
    declarations.map(async (declaration) => {
      if (
        !(await ctx.core.isPrincipalInSpace(target.id, declaration.spaceId))
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          `API key holder is not a direct member of declared space: ${declaration.spaceId}`,
        );
      }
      try {
        return {
          ...declaration,
          grants: declaration.grants.map((grant) => ({
            ...grant,
            treePath: normalizeTreePath(
              grant.treePath,
              target.kind === "u" ? { home: target.id } : {},
            ),
          })),
        };
      } catch (error) {
        if (error instanceof TreePathError) {
          throw new AppError("VALIDATION_ERROR", error.message);
        }
        throw error;
      }
    }),
  );
  const spaces = new Set<string>();
  for (const declaration of normalized) {
    if (spaces.has(declaration.spaceId)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `API key access contains duplicate space declaration: ${declaration.spaceId}`,
      );
    }
    spaces.add(declaration.spaceId);
    const paths = new Set<string>();
    for (const grant of declaration.grants) {
      if (paths.has(grant.treePath)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `API key access contains duplicate tree path: ${grant.treePath}`,
        );
      }
      paths.add(grant.treePath);
    }
  }
  return normalized;
}

function toApiKeyInfoResponse(k: ApiKeyInfo): ApiKeyInfoResponse {
  return {
    id: k.id,
    memberId: k.memberId,
    lookupId: k.lookupId,
    name: k.name,
    restricted: k.restricted,
    createdAt: k.createdAt.toISOString(),
    expiresAt: k.expiresAt?.toISOString() ?? null,
    lastUsedOn: k.lastUsedOn,
  };
}

function toApiKeyAccessResponse(a: ApiKeyAccess): ApiKeyAccessResponse {
  return {
    spaceId: a.spaceId,
    slug: a.slug,
    spaceAdmin: a.spaceAdmin,
    grants: a.grants,
  };
}

async function apiKeyCreate(
  params: ApiKeyCreateParams,
  context: HandlerContext,
): Promise<ApiKeyCreateResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  denyApiKeyCaller(ctx); // keys can't mint keys
  const target = await requireKeyAuthority(ctx, params.memberId);
  const access = await normalizeAccessDeclarations(ctx, target, params.access);

  const created = await guardCore(() =>
    ctx.core.createApiKey(params.memberId, params.name, {
      expiresAt: params.expiresAt ? new Date(params.expiresAt) : undefined,
      access,
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
  await requireKeyAuthority(ctx, params.memberId);
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
  if (!key) return { apiKey: null, access: [] };
  await requireKeyAuthority(ctx, key.memberId);
  const access = await ctx.core.listApiKeyAccess(key.id);
  return {
    apiKey: toApiKeyInfoResponse(key),
    access: access.map(toApiKeyAccessResponse),
  };
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
  await requireKeyAuthority(ctx, key.memberId);
  const deleted = await guardCore(() => ctx.core.deleteApiKey(params.id));
  return { deleted };
}

export const apiKeyMethods = buildRegistry()
  .register("apiKey.create", apiKeyCreateParams, apiKeyCreate)
  .register("apiKey.list", apiKeyListParams, apiKeyList)
  .register("apiKey.get", apiKeyGetParams, apiKeyGet)
  .register("apiKey.delete", apiKeyDeleteParams, apiKeyDelete)
  .build();
