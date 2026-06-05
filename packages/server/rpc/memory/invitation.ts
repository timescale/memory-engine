/**
 * Space invitation handlers (invite.*).
 *
 * Inviting an *already-registered* user adds them to the space immediately —
 * access is recomputed per request (build_tree_access), so it takes effect on
 * their existing session without a re-login. Inviting a not-yet-registered email
 * records a pending invitation, redeemed at their first verified login (see
 * redeemInvitationsForVerifiedLogin). Both paths grant owner@home and, when a
 * share level is set, that level at the shared root.
 *
 * Authority: all three methods require space-admin (structural authority over
 * the roster, like group management — owner@root alone is not enough). Inviting
 * people, optionally as admins, is a deliberate structural act.
 */
import { SHARE_NAMESPACE } from "@memory.build/database";
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

  // Already-registered user → add them now (instant access on their existing
  // session). Not-yet-registered → a pending invite, redeemed at first login.
  const existing = await ctx.core.getUserByName(params.email);
  if (existing) {
    await guardCore(async () => {
      await ctx.core.addPrincipalToSpace(ctx.space.id, existing.id, admin);
      if (shareAccess !== null) {
        await ctx.core.grantTreeAccess(
          ctx.space.id,
          existing.id,
          SHARE_NAMESPACE,
          shareAccess,
        );
      }
    });
    return { applied: true, invitationId: null, principalId: existing.id };
  }

  const invitationId = await guardCore(() =>
    ctx.core.createSpaceInvitation(ctx.space.id, params.email, {
      admin,
      shareAccess,
      invitedBy: ctx.principalId,
    }),
  );
  return { applied: false, invitationId, principalId: null };
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
