/**
 * Accounts RPC invitation methods.
 *
 * Implements:
 * - invitation.create: Create an invitation to join an organization
 * - invitation.list: List pending invitations for an organization
 * - invitation.revoke: Revoke a pending invitation
 * - invitation.accept: Accept an invitation (adds caller to org)
 */
import type { Invitation } from "@memory-engine/accounts";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  type InvitationAcceptParams,
  type InvitationCreateParams,
  type InvitationListParams,
  type InvitationRevokeParams,
  invitationAcceptSchema,
  invitationCreateSchema,
  invitationListSchema,
  invitationRevokeSchema,
} from "./schemas";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

// =============================================================================
// Response Types
// =============================================================================

/**
 * Invitation response (serializable).
 */
interface InvitationResponse {
  id: string;
  orgId: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/**
 * Convert an Invitation to a serializable response.
 */
function toInvitationResponse(invitation: Invitation): InvitationResponse {
  return {
    id: invitation.id,
    orgId: invitation.orgId,
    email: invitation.email,
    role: invitation.role,
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt.toISOString(),
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
    createdAt: invitation.createdAt.toISOString(),
  };
}

/**
 * Invitation create response includes the token (only shown once).
 */
interface InvitationCreateResponse extends InvitationResponse {
  token: string;
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * invitation.create - Create an invitation to join an organization.
 * Requires owner or admin role.
 * Returns the invitation with the raw token (only shown once).
 */
async function invitationCreate(
  params: InvitationCreateParams,
  context: HandlerContext,
): Promise<InvitationCreateResponse> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const member = await db.getMember(params.orgId, identity.id);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners and admins can create invitations",
    );
  }

  // Only owners can invite other owners
  if (params.role === "owner" && member.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only owners can invite other owners");
  }

  const result = await db.createInvitation({
    orgId: params.orgId,
    email: params.email,
    role: params.role,
    invitedBy: identity.id,
    expiresInDays: params.expiresInDays,
  });

  return {
    ...toInvitationResponse(result.invitation),
    token: result.rawToken,
  };
}

/**
 * invitation.list - List pending invitations for an organization.
 * Requires membership in the org.
 */
async function invitationList(
  params: InvitationListParams,
  context: HandlerContext,
): Promise<{ invitations: InvitationResponse[] }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller is a member of the org
  const member = await db.getMember(params.orgId, identity.id);
  if (!member) {
    throw new AppError("FORBIDDEN", "Not a member of this organization");
  }

  const invitations = await db.listPendingInvitations(params.orgId);
  return { invitations: invitations.map(toInvitationResponse) };
}

/**
 * invitation.revoke - Revoke a pending invitation.
 * Requires owner or admin role.
 */
async function invitationRevoke(
  params: InvitationRevokeParams,
  context: HandlerContext,
): Promise<{ revoked: boolean }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // We need to find the invitation first to check org membership
  // Since we don't have getInvitation by ID, we'll need to verify via different means
  // For now, we'll revoke and let the database handle the not found case
  // The authorization check happens via listing invitations for orgs the user is admin of

  // Get all orgs the caller is admin/owner of
  const orgs = await db.listOrgsByIdentity(identity.id);

  // For each org, check if the invitation belongs to it and caller has permission
  for (const org of orgs) {
    const member = await db.getMember(org.id, identity.id);
    if (member && (member.role === "owner" || member.role === "admin")) {
      const invitations = await db.listPendingInvitations(org.id);
      const invitation = invitations.find((inv) => inv.id === params.id);
      if (invitation) {
        const revoked = await db.revokeInvitation(params.id);
        return { revoked };
      }
    }
  }

  throw new AppError("NOT_FOUND", `Invitation not found: ${params.id}`);
}

/**
 * invitation.accept - Accept an invitation (adds caller to org).
 * The caller's email must match the invitation email.
 */
async function invitationAccept(
  params: InvitationAcceptParams,
  context: HandlerContext,
): Promise<{ accepted: boolean; orgId: string }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Find the invitation by token
  const invitation = await db.getInvitationByToken(params.token);
  if (!invitation) {
    throw new AppError("NOT_FOUND", "Invalid or expired invitation token");
  }

  // Check email matches (identity already available from auth - no DB lookup needed)
  if (invitation.email.toLowerCase() !== identity.email.toLowerCase()) {
    throw new AppError(
      "FORBIDDEN",
      "Invitation is for a different email address",
    );
  }

  // Accept the invitation and add member in a transaction
  await db.withTransaction(async (txDb) => {
    const accepted = await txDb.acceptInvitation(invitation.id);
    if (!accepted) {
      throw new AppError("CONFLICT", "Invitation has already been accepted");
    }

    // Add the user as a member with the invited role
    await txDb.addMember(invitation.orgId, identity.id, invitation.role);
  });

  return { accepted: true, orgId: invitation.orgId };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the invitation methods registry.
 */
export const invitationMethods = buildRegistry()
  .register("invitation.create", invitationCreateSchema, invitationCreate)
  .register("invitation.list", invitationListSchema, invitationList)
  .register("invitation.revoke", invitationRevokeSchema, invitationRevoke)
  .register("invitation.accept", invitationAcceptSchema, invitationAccept)
  .build();
