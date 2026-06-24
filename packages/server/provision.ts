import {
  generateSlug,
  provisionSpace,
  SHARE_NAMESPACE,
} from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import { info, reportError } from "@pydantic/logfire-node";
import type { Sql } from "postgres";

/**
 * First-login provisioning (core side).
 *
 * better-auth owns the `auth.users` + `accounts` rows (created on social login).
 * This module stands up the matching core side — a `core.principal` sharing the
 * auth user id, a default space + its `me_<slug>` data schema, and the creator
 * grants — lazily on the first authenticated user RPC (see
 * {@link ensureUserProvisioned}), plus the invitation-redemption hook.
 */

/**
 * Grant a new space's creator its default access — shared by first-login
 * provisioning and `space.create` so the two stay in lockstep. The creator
 * becomes a space admin who owns its home (via add_principal_to_space) and the
 * shared root (`share`), but NOT owner@root: it sees `/share` and its own `~`,
 * not other members' homes. As an admin it can self-grant owner@root later if it
 * wants the whole tree. Call inside the space-creation transaction.
 */
export async function addSpaceCreator(
  core: engineCore.CoreStore,
  spaceId: string,
  userId: string,
): Promise<void> {
  await core.addPrincipalToSpace(spaceId, userId, true); // admin + owner@home
  await core.grantTreeAccess(
    spaceId,
    userId,
    SHARE_NAMESPACE,
    engineCore.ACCESS.owner,
  );
}

/**
 * Redeem pending space invitations for a (provider-verified) login email: join
 * the user to each invited space (owner@home + the per-invite share level).
 * Idempotent and best-effort — a failure is logged and swallowed so it never
 * breaks the request (the next call retries). Returns the number of spaces
 * joined. The user must already be a core principal, and the email must be one
 * the identity provider verified (invitations are email-keyed; redeeming for an
 * unverified address would let a caller claim invites they don't control).
 */
export async function redeemInvitationsForVerifiedLogin(
  core: engineCore.CoreStore,
  userId: string,
  email: string,
): Promise<number> {
  try {
    const joined = await core.redeemSpaceInvitations(userId, email);
    if (joined.length > 0) {
      info("Redeemed space invitations", { email, spaces: joined.length });
    }
    return joined.length;
  } catch (err) {
    reportError("Invitation redemption failed (continuing)", err as Error, {
      email,
    });
    return 0;
  }
}

export interface EnsureProvisionedParams {
  /** The authenticated user id (== auth.users.id == core.principal.id). */
  userId: string;
  /** The user's email — the globally-unique core principal name. */
  email: string;
  /**
   * Whether the identity provider verified the email. Invitations are
   * email-keyed, so redemption only runs for a verified address — an unverified
   * email must not auto-join spaces invited to it. Defaults to not-verified.
   */
  emailVerified?: boolean;
  /** Name for the personal space (default "default"). */
  spaceName?: string;
}

/**
 * Lazy, idempotent core-side provisioning for a better-auth user.
 *
 * better-auth owns the `auth.users` + `accounts` rows; this stands up the core
 * side the first time an authenticated user is seen on the user RPC: the
 * `core.principal` (sharing the auth user id), a default space + its me_<slug>
 * schema, and the creator grants — the same shape `provisionUser` used to build
 * in one transaction at signup.
 *
 * Idempotent (a no-op once the principal exists), so it can run on every
 * authenticated request. Concurrent first-requests race safely: the loser either
 * sees the principal already present or hits a unique violation, re-checks, and
 * returns. Runs on the app pool — the auth user was already committed by
 * better-auth (a different pool, same DB) so it is visible here.
 */
export async function ensureUserProvisioned(
  sql: Sql,
  core: engineCore.CoreStore,
  schemas: { core: string },
  params: EnsureProvisionedParams,
): Promise<void> {
  // Provision the core side on first sight (idempotent); skip when already done.
  if (!(await core.getPrincipal(params.userId))) {
    const slug = generateSlug();
    try {
      await sql.begin(async (tx) => {
        const txCore = engineCore.coreStore(tx as unknown as Sql, schemas.core);
        // Re-check inside the transaction to narrow the provisioning race window.
        if (await txCore.getPrincipal(params.userId)) return;
        // Principal name is the email (its unique handle); display name lives on
        // the better-auth user row.
        await txCore.createUser(params.userId, params.email);
        const spaceId = await txCore.createSpace(
          slug,
          params.spaceName ?? "default",
        );
        await provisionSpace(tx, { slug }); // creates the me_<slug> data schema
        await addSpaceCreator(txCore, spaceId, params.userId);
      });
    } catch (error) {
      // A concurrent first-request may have provisioned us first. If the
      // principal now exists the race resolved in our favor; else re-throw.
      if (!(await core.getPrincipal(params.userId))) throw error;
    }
  }

  // Join any spaces this email was invited to. better-auth gives us no
  // dedicated "login" hook, so this rides every user RPC — it's idempotent and
  // best-effort (a no-op once nothing is pending). Gated on a provider-VERIFIED
  // email: invitations are email-keyed, so an unverified address must not
  // auto-join spaces invited to it. This is the new home of the redemption the
  // retired device-flow callback ran on each sign-in.
  if (params.emailVerified) {
    await redeemInvitationsForVerifiedLogin(core, params.userId, params.email);
  }
}
