/**
 * Service-account handlers (serviceAccount.*) for the user RPC.
 *
 * Service accounts are space-scoped API-key-bearing principals. They are created
 * by space admins and administered by direct user members of a bound admin group.
 * Deletion is intentionally stricter than rename/key management: space-admin
 * only.
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
    throw new AppError("FORBIDDEN", "This action requires being a space admin");
  }
}

export async function requireServiceAccountManager(
  ctx: UserRpcContext,
  serviceAccountId: string,
  opts: { allowAdminGroup?: boolean } = {},
): Promise<ServiceAccount> {
  const account = await ctx.core.getServiceAccount(serviceAccountId);
  if (!account) {
    throw new AppError(
      "NOT_FOUND",
      `Service account not found: ${serviceAccountId}`,
    );
  }
  if (await ctx.core.isSpaceAdmin(ctx.userId, account.spaceId)) return account;
  if (
    opts.allowAdminGroup !== false &&
    (await ctx.core.isServiceAccountAdmin(account.id, ctx.userId))
  ) {
    return account;
  }
  throw new AppError(
    "FORBIDDEN",
    "This action requires being a space admin or service-account admin",
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
  const accounts = await ctx.core.listServiceAccounts(params.spaceId);
  if (await ctx.core.isSpaceAdmin(ctx.userId, params.spaceId)) {
    return { serviceAccounts: accounts.map(toServiceAccountResponse) };
  }
  const administered: ServiceAccount[] = [];
  for (const account of accounts) {
    if (await ctx.core.isServiceAccountAdmin(account.id, ctx.userId)) {
      administered.push(account);
    }
  }
  return { serviceAccounts: administered.map(toServiceAccountResponse) };
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
  await requireServiceAccountManager(ctx, params.id, {
    allowAdminGroup: false,
  });
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
