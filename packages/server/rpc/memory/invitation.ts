/**
 * Space invitation handlers (invite.*) — the admin side.
 *
 * One unified surface: an `email` invite is email-constrained (only that verified
 * email may redeem, single-use); an invite with no `email` is an open shareable
 * link (anyone logged in may redeem, multi-use, optional expiry / max-uses).
 * Every invite is **pending** — the invitee joins by explicitly accepting it
 * (invitee-side `invite.*` on the user RPC) or by redeeming its token link; no
 * path auto-enrolls. `invite.create` mints and returns the magic-link token once.
 *
 * Authority: all methods require space-admin (structural authority over the
 * roster, like group management — owner@root alone is not enough). Inviting
 * people, optionally as admins, is a deliberate structural act.
 */

import type {
  InviteCreateParams,
  InviteCreateResult,
  InviteListParams,
  InviteListResult,
  InviteRevokeByIdParams,
  InviteRevokeByIdResult,
  InviteRevokeParams,
  InviteRevokeResult,
} from "@memory.build/protocol/space";
import {
  inviteCreateParams,
  inviteListParams,
  inviteRevokeByIdParams,
  inviteRevokeParams,
} from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertGroupInSpace } from "./group";
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
  // The redeemer joins this group (its grants are their access). Required — the
  // client chooses it (the CLI/web default to the "team" group); the server does
  // not guess. Validated here for a clean NOT_FOUND (the FK would also reject a
  // group from another space).
  await assertGroupInSpace(ctx, params.groupId);
  const admin = params.admin ?? false;
  const email = params.email ?? null; // null → an open shareable link

  // Always pending — no auto-enroll. The invitee joins by accepting (email
  // invite) or by redeeming the returned token link. The token is returned here
  // and re-readable later by an admin via invite.list (so the URL can be re-copied).
  const { id, token } = await guardCore(() =>
    ctx.core.createSpaceInvitation(ctx.space.id, email, {
      admin,
      groupId: params.groupId,
      invitedBy: ctx.principalId,
      expiresAt: params.expiresAt ? new Date(params.expiresAt) : null,
      maxUses: params.maxUses ?? null,
    }),
  );
  return { invitationId: id, token };
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

async function inviteRevokeById(
  params: InviteRevokeByIdParams,
  context: HandlerContext,
): Promise<InviteRevokeByIdResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  const revoked = await guardCore(() =>
    ctx.core.revokeInvitationById(ctx.space.id, params.invitationId),
  );
  return { revoked };
}

export const invitationMethods = buildRegistry()
  .register("invite.create", inviteCreateParams, inviteCreate)
  .register("invite.list", inviteListParams, inviteList)
  .register("invite.revoke", inviteRevokeParams, inviteRevoke)
  .register("invite.revokeById", inviteRevokeByIdParams, inviteRevokeById)
  .build();
