/**
 * Accounts RPC org methods.
 *
 * Implements:
 * - org.create: Create a new organization (caller becomes owner)
 * - org.list: List organizations for the current identity
 * - org.get: Get organization by ID
 * - org.update: Update organization name/slug
 * - org.delete: Delete an organization
 */
import type { Org } from "@memory-engine/accounts";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  type OrgCreateParams,
  type OrgDeleteParams,
  type OrgGetParams,
  type OrgListParams,
  type OrgUpdateParams,
  orgCreateSchema,
  orgDeleteSchema,
  orgGetSchema,
  orgListSchema,
  orgUpdateSchema,
} from "./schemas";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

// =============================================================================
// Response Types
// =============================================================================

/**
 * Org response (serializable).
 */
interface OrgResponse {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string | null;
}

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
  const { db, identityId } = context as AccountsRpcContext;

  // Create org and add creator as owner in a transaction
  const org = await db.withTransaction(async (txDb) => {
    const newOrg = await txDb.createOrg({
      slug: params.slug,
      name: params.name,
    });

    // Add creator as owner
    await txDb.addMember(newOrg.id, identityId, "owner");

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
  const { db, identityId } = context as AccountsRpcContext;

  const orgs = await db.listOrgsByIdentity(identityId);
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
  const { db, identityId } = context as AccountsRpcContext;

  // Check if caller is a member of the org
  const member = await db.getMember(params.id, identityId);
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
 * org.update - Update organization name/slug.
 * Requires owner or admin role.
 */
async function orgUpdate(
  params: OrgUpdateParams,
  context: HandlerContext,
): Promise<OrgResponse> {
  assertAccountsRpcContext(context);
  const { db, identityId } = context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const member = await db.getMember(params.id, identityId);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners and admins can update the organization",
    );
  }

  const updated = await db.updateOrg(params.id, {
    name: params.name,
    slug: params.slug,
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
 * Requires owner role.
 */
async function orgDelete(
  params: OrgDeleteParams,
  context: HandlerContext,
): Promise<{ deleted: boolean }> {
  assertAccountsRpcContext(context);
  const { db, identityId } = context as AccountsRpcContext;

  // Check if caller is an owner
  const member = await db.getMember(params.id, identityId);
  if (!member || member.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only owners can delete the organization");
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
  .register("org.create", orgCreateSchema, orgCreate)
  .register("org.list", orgListSchema, orgList)
  .register("org.get", orgGetSchema, orgGet)
  .register("org.update", orgUpdateSchema, orgUpdate)
  .register("org.delete", orgDeleteSchema, orgDelete)
  .build();
