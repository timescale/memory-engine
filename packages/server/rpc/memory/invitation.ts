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
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  guardCore,
  requireSpaceAdmin,
  toSpaceInvitationResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

/**
 * Validate every id in `groupIds` is a group in this space and return the deduped
 * set (clean NOT_FOUND on the first stray id; the coherence trigger is the
 * DB-level backstop). Required — the client picks the groups (the CLI/web default
 * to the "team" group); the server does not guess.
 */
async function resolveInviteGroupIds(
  ctx: SpaceRpcContext,
  groupIds: string[],
): Promise<string[]> {
  const inSpace = new Set(
    (await ctx.core.listSpaceGroups(ctx.space.id)).map((g) => g.id),
  );
  for (const id of groupIds) {
    if (!inSpace.has(id)) {
      throw new AppError("NOT_FOUND", `Group not found in this space: ${id}`);
    }
  }
  return [...new Set(groupIds)];
}

async function inviteCreate(
  params: InviteCreateParams,
  context: HandlerContext,
): Promise<InviteCreateResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  await requireSpaceAdmin(ctx);
  const groupIds = await resolveInviteGroupIds(ctx, params.groupIds);
  const admin = params.admin ?? false;
  const email = params.email ?? null; // null → an open shareable link

  // Always pending — no auto-enroll. The invitee joins by accepting (email
  // invite) or by redeeming the returned token link. The token is returned here
  // and re-readable later by an admin via invite.list (so the URL can be re-copied).
  const { id, token } = await guardCore(() =>
    ctx.core.createSpaceInvitation(ctx.space.id, email, {
      admin,
      groupIds,
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
  await requireSpaceAdmin(ctx);
  const invitations = await ctx.core.listSpaceInvitations(ctx.space.id);
  return { invitations: invitations.map(toSpaceInvitationResponse) };
}

async function inviteRevoke(
  params: InviteRevokeParams,
  context: HandlerContext,
): Promise<InviteRevokeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  await requireSpaceAdmin(ctx);
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
  await requireSpaceAdmin(ctx);
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
