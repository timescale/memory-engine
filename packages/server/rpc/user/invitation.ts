/**
 * Invitee-side invitation handlers (invite.*) for the **user RPC**.
 *
 * An invitee is not yet a space member, so they can't reach the space endpoint;
 * these account-scoped methods let them see and act on invitations addressed to
 * their verified email: list the pending ones, accept (join), or decline. The
 * admin side (`invite.create`/`list`/`revoke` for a space) lives on the space RPC.
 *
 * Gated on a verified email: invitations are email-keyed, so a caller may only
 * act on invitations addressed to their own provider-verified address. Agents
 * have no email and are denied by the user-RPC allow-list (these methods are not
 * in `AGENT_ALLOWED`).
 */
import type {
  InviteAcceptParams,
  InviteAcceptResult,
  InviteDeclineParams,
  InviteDeclineResult,
  InvitePendingParams,
  InvitePendingResult,
  InviteRedeemParams,
  InviteRedeemResult,
} from "@memory.build/protocol/user";
import {
  inviteAcceptParams,
  inviteDeclineParams,
  invitePendingParams,
  inviteRedeemParams,
} from "@memory.build/protocol/user";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertUserRpcContext, type UserRpcContext } from "./types";

/**
 * Resolve the caller's verified email, or reject. Invitations are addressed by
 * email; acting on one requires the caller to control that provider-verified
 * address (an unverified or absent email — e.g. an agent — must not).
 */
function requireVerifiedEmail(ctx: UserRpcContext): string {
  if (ctx.email === null || !ctx.emailVerified) {
    throw new AppError(
      "FORBIDDEN",
      "A verified email is required to view or accept invitations.",
    );
  }
  return ctx.email;
}

async function invitePending(
  _params: InvitePendingParams,
  context: HandlerContext,
): Promise<InvitePendingResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const email = requireVerifiedEmail(ctx);
  const invitations = await ctx.core.listInvitationsForEmail(email);
  return {
    invitations: invitations.map((i) => ({
      invitationId: i.invitationId,
      spaceId: i.spaceId,
      spaceSlug: i.slug,
      spaceName: i.name,
      admin: i.admin,
      groupName: i.groupName,
      invitedByName: i.invitedByName,
      createdAt: i.createdAt.toISOString(),
    })),
  };
}

async function inviteAccept(
  params: InviteAcceptParams,
  context: HandlerContext,
): Promise<InviteAcceptResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const email = requireVerifiedEmail(ctx);
  const joined = await ctx.core.acceptSpaceInvitation(
    ctx.userId,
    email,
    params.invitationId,
  );
  if (!joined) {
    throw new AppError(
      "NOT_FOUND",
      "No pending invitation with that id is addressed to your email.",
    );
  }
  return { spaceSlug: joined.slug, spaceName: joined.name };
}

async function inviteDecline(
  params: InviteDeclineParams,
  context: HandlerContext,
): Promise<InviteDeclineResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const email = requireVerifiedEmail(ctx);
  const declined = await ctx.core.declineSpaceInvitation(
    email,
    params.invitationId,
  );
  return { declined };
}

/**
 * Redeem a magic-link token. Unlike accept/decline this is NOT email-keyed: an
 * open link is redeemable by any logged-in user, and an email-constrained link's
 * email check happens in SQL against the caller's email. So it doesn't require a
 * verified email — only a logged-in user (agents are barred by the allow-list).
 *
 * Only a *verified* email is passed for the constraint check, mirroring `accept`'s
 * requireVerifiedEmail: an unverified email must not satisfy an email-constrained
 * link. An open link (email null) ignores the caller's email, so it still works.
 */
async function inviteRedeem(
  params: InviteRedeemParams,
  context: HandlerContext,
): Promise<InviteRedeemResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const joined = await ctx.core.redeemInvitation(
    params.token,
    ctx.userId,
    ctx.emailVerified ? ctx.email : null,
  );
  if (!joined) {
    throw new AppError(
      "NOT_FOUND",
      "This invite link is invalid, expired, revoked, fully used, or for a different email.",
    );
  }
  return { spaceSlug: joined.slug, spaceName: joined.name };
}

export const inviteeMethods = buildRegistry()
  .register("invite.pending", invitePendingParams, invitePending)
  .register("invite.accept", inviteAcceptParams, inviteAccept)
  .register("invite.decline", inviteDeclineParams, inviteDecline)
  .register("invite.redeem", inviteRedeemParams, inviteRedeem)
  .build();
