/**
 * Space invitation handlers (invite.*) — the admin side.
 *
 * Inviting an email — registered or not — records a **pending** invitation; the
 * invitee joins by explicitly accepting it (invitee-side `invite.*` on the user
 * RPC), never by auto-enrollment. Accepting grants owner@home and, when a share
 * level is set, that level at the shared root.
 *
 * Authority: all three methods require space-admin (structural authority over
 * the roster, like group management — owner@root alone is not enough). Inviting
 * people, optionally as admins, is a deliberate structural act.
 */
import type {
  InviteCreateParams,
  InviteCreateResult,
  InviteListParams,
  InviteListResult,
  InviteRevokeParams,
  InviteRevokeResult,
} from "@memory.build/protocol/space";
import {
  inviteCreateParams,
  inviteListParams,
  inviteRevokeParams,
} from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  guardCore,
  requireSpaceAdmin,
  toSpaceInvitationResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

async function inviteCreate(
  params: InviteCreateParams,
  context: HandlerContext,
): Promise<InviteCreateResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  const admin = params.admin ?? false;
  const shareAccess = params.shareAccess ?? null;

  // Always record a pending invitation — no auto-enroll, even for an existing
  // user. The invitee joins by accepting it (invite.accept on the user RPC).
  const invitationId = await guardCore(() =>
    ctx.core.createSpaceInvitation(ctx.space.id, params.email, {
      admin,
      shareAccess,
      invitedBy: ctx.principalId,
    }),
  );
  return { invitationId };
}

async function inviteList(
  _params: InviteListParams,
  context: HandlerContext,
): Promise<InviteListResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  const invitations = await ctx.core.listSpaceInvitations(ctx.space.id);
  return { invitations: invitations.map(toSpaceInvitationResponse) };
}

async function inviteRevoke(
  params: InviteRevokeParams,
  context: HandlerContext,
): Promise<InviteRevokeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  const revoked = await guardCore(() =>
    ctx.core.revokeSpaceInvitation(ctx.space.id, params.email),
  );
  return { revoked };
}

export const invitationMethods = buildRegistry()
  .register("invite.create", inviteCreateParams, inviteCreate)
  .register("invite.list", inviteListParams, inviteList)
  .register("invite.revoke", inviteRevokeParams, inviteRevoke)
  .build();
