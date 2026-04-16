/**
 * Accounts RPC org methods.
 *
 * Implements:
 * - org.create: Create a new organization (caller becomes owner)
 * - org.list: List organizations for the current identity
 * - org.get: Get organization by ID
 * - org.update: Update organization name
 * - org.delete: Delete an organization
 */
import type { Org } from "@memory.build/accounts";
import type {
  OrgCreateParams,
  OrgDeleteParams,
  OrgGetParams,
  OrgListParams,
  OrgResponse,
  OrgUpdateParams,
} from "@memory.build/protocol/accounts/org";
import {
  orgCreateParams,
  orgDeleteParams,
  orgGetParams,
  orgListParams,
  orgUpdateParams,
} from "@memory.build/protocol/accounts/org";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

/**
 * Convert an Org to a serializable response.
 */
function toOrgResponse(org: Org): OrgResponse {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt?.toISOString() ?? null,
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * org.create - Create a new organization.
 * The authenticated identity automatically becomes the owner.
 */
async function orgCreate(
  params: OrgCreateParams,
  context: HandlerContext,
): Promise<OrgResponse> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Create org and add creator as owner in a transaction
  const org = await db.withTransaction(async (txDb) => {
    const newOrg = await txDb.createOrg({
      name: params.name,
    });

    // Add creator as owner
    await txDb.addMember(newOrg.id, identity.id, "owner");

    return newOrg;
  });

  return toOrgResponse(org);
}

/**
 * org.list - List organizations for the current identity.
 */
async function orgList(
  _params: OrgListParams,
  context: HandlerContext,
): Promise<{ orgs: OrgResponse[] }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  const orgs = await db.listOrgsByIdentity(identity.id);
  return { orgs: orgs.map(toOrgResponse) };
}

/**
 * org.get - Get organization by ID.
 */
async function orgGet(
  params: OrgGetParams,
  context: HandlerContext,
): Promise<OrgResponse> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller is a member of the org
  const member = await db.getMember(params.id, identity.id);
  if (!member) {
    throw new AppError("FORBIDDEN", "Not a member of this organization");
  }

  const org = await db.getOrg(params.id);
  if (!org) {
    throw new AppError("NOT_FOUND", `Organization not found: ${params.id}`);
  }

  return toOrgResponse(org);
}

/**
 * org.update - Update organization name.
 * Requires owner or admin role.
 */
async function orgUpdate(
  params: OrgUpdateParams,
  context: HandlerContext,
): Promise<OrgResponse> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const member = await db.getMember(params.id, identity.id);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners and admins can update the organization",
    );
  }

  const updated = await db.updateOrg(params.id, {
    name: params.name,
  });

  if (!updated) {
    throw new AppError("NOT_FOUND", `Organization not found: ${params.id}`);
  }

  const org = await db.getOrg(params.id);
  if (!org) {
    throw new AppError("NOT_FOUND", `Organization not found: ${params.id}`);
  }

  return toOrgResponse(org);
}

/**
 * org.delete - Delete an organization.
 * Requires owner role. Refuses if:
 * - The org has any engines (delete engines first)
 * - It's the caller's only owned org
 */
async function orgDelete(
  params: OrgDeleteParams,
  context: HandlerContext,
): Promise<{ deleted: boolean }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller is an owner
  const member = await db.getMember(params.id, identity.id);
  if (!member || member.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only owners can delete the organization");
  }

  // Refuse if the org still has engines
  const engines = await db.listEnginesByOrg(params.id);
  if (engines.length > 0) {
    throw new AppError(
      "CONFLICT",
      "Cannot delete organization with engines. Delete all engines first.",
    );
  }

  // Refuse if this is the caller's only owned org
  const ownedCount = await db.countOwnedOrgs(identity.id);
  if (ownedCount <= 1) {
    throw new AppError("CONFLICT", "Cannot delete your only organization.");
  }

  const deleted = await db.deleteOrg(params.id);
  if (!deleted) {
    throw new AppError("NOT_FOUND", `Organization not found: ${params.id}`);
  }

  return { deleted };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the org methods registry.
 */
export const orgMethods = buildRegistry()
  .register("org.create", orgCreateParams, orgCreate)
  .register("org.list", orgListParams, orgList)
  .register("org.get", orgGetParams, orgGet)
  .register("org.update", orgUpdateParams, orgUpdate)
  .register("org.delete", orgDeleteParams, orgDelete)
  .build();
