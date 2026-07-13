/**
 * Service-account handlers (serviceAccount.*) for the user RPC.
 *
 * Service accounts are space-scoped API-key-bearing principals. They are created
 * by space admins; once created, they are administered by space admins and by
 * direct user members of the bound admin group (`is_service_account_admin`).
 * All post-creation management — rename, delete, and api-key mint/revoke — shares
 * that single authority; only `create` is space-admin-only.
 */
import type { ServiceAccount } from "@memory.build/engine/core";
import type {
  ServiceAccountCreateParams,
  ServiceAccountCreateResult,
  ServiceAccountDeleteParams,
  ServiceAccountDeleteResult,
  ServiceAccountListParams,
  ServiceAccountListResult,
  ServiceAccountRenameParams,
  ServiceAccountRenameResult,
  ServiceAccountResponse,
} from "@memory.build/protocol/user";
import {
  serviceAccountCreateParams,
  serviceAccountDeleteParams,
  serviceAccountListParams,
  serviceAccountRenameParams,
} from "@memory.build/protocol/user";
import { forbiddenNamingAdmins } from "../admin-contacts";
import { guardCore } from "../core-error";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertUserRpcContext, type UserRpcContext } from "./types";

function toServiceAccountResponse(
  account: ServiceAccount,
): ServiceAccountResponse {
  return {
    id: account.id,
    name: account.name,
    adminId: account.adminId,
    spaceId: account.spaceId,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt?.toISOString() ?? null,
  };
}

async function requireSpaceAdminById(
  ctx: UserRpcContext,
  spaceId: string,
): Promise<void> {
  if (!(await ctx.core.isSpaceAdmin(ctx.userId, spaceId))) {
    // Enriched with the effective admins' contacts: for a repo dev running
    // `me project ci`, this denial is the expected common case — the error
    // must carry whom to ask, not be a dead end.
    throw await forbiddenNamingAdmins(
      ctx.core,
      spaceId,
      "This action requires being a space admin",
    );
  }
}

/**
 * Authorize a caller to manage an existing service account (rename, delete, or
 * api-key mint/revoke). Allowed for a space admin, or a direct user member of the
 * service account's bound admin group (`is_service_account_admin`). Returns the
 * loaded account so callers avoid a second fetch.
 */
export async function requireServiceAccountManager(
  ctx: UserRpcContext,
  serviceAccountId: string,
): Promise<ServiceAccount> {
  const account = await ctx.core.getServiceAccount(serviceAccountId);
  if (!account) {
    throw new AppError(
      "NOT_FOUND",
      `Service account not found: ${serviceAccountId}`,
    );
  }
  if (await ctx.core.isSpaceAdmin(ctx.userId, account.spaceId)) return account;
  if (await ctx.core.isServiceAccountAdmin(account.id, ctx.userId)) {
    return account;
  }
  throw await forbiddenNamingAdmins(
    ctx.core,
    account.spaceId,
    "This action requires being a space admin or a service-account admin",
  );
}

async function serviceAccountCreate(
  params: ServiceAccountCreateParams,
  context: HandlerContext,
): Promise<ServiceAccountCreateResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireSpaceAdminById(ctx, params.spaceId);
  const account = await guardCore(() =>
    ctx.core.createServiceAccount(params.spaceId, params.name, {
      adminMembers: params.adminMembers,
    }),
  );
  return { serviceAccount: toServiceAccountResponse(account) };
}

async function serviceAccountList(
  params: ServiceAccountListParams,
  context: HandlerContext,
): Promise<ServiceAccountListResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  // Space admins see all; everyone else sees only the accounts they administer.
  // Both are a single DB round trip (no per-account isServiceAccountAdmin probe).
  const accounts = (await ctx.core.isSpaceAdmin(ctx.userId, params.spaceId))
    ? await ctx.core.listServiceAccounts(params.spaceId)
    : await ctx.core.listServiceAccountsForAdmin(params.spaceId, ctx.userId);
  return { serviceAccounts: accounts.map(toServiceAccountResponse) };
}

async function serviceAccountRename(
  params: ServiceAccountRenameParams,
  context: HandlerContext,
): Promise<ServiceAccountRenameResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireServiceAccountManager(ctx, params.id);
  const renamed = await guardCore(() =>
    ctx.core.renameServiceAccount(params.id, params.name),
  );
  return { renamed };
}

async function serviceAccountDelete(
  params: ServiceAccountDeleteParams,
  context: HandlerContext,
): Promise<ServiceAccountDeleteResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireServiceAccountManager(ctx, params.id);
  const deleted = await guardCore(() =>
    ctx.core.deleteServiceAccount(params.id),
  );
  return { deleted };
}

export const serviceAccountMethods = buildRegistry()
  .register(
    "serviceAccount.create",
    serviceAccountCreateParams,
    serviceAccountCreate,
  )
  .register("serviceAccount.list", serviceAccountListParams, serviceAccountList)
  .register(
    "serviceAccount.rename",
    serviceAccountRenameParams,
    serviceAccountRename,
  )
  .register(
    "serviceAccount.delete",
    serviceAccountDeleteParams,
    serviceAccountDelete,
  )
  .build();
