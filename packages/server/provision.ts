import { authStore, type OAuthProvider } from "@memory.build/auth";
import {
  generateSlug,
  provisionSpace,
  SHARE_NAMESPACE,
} from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import { info, reportError } from "@pydantic/logfire-node";
import type { Sql } from "postgres";

/**
 * First-login provisioning.
 *
 * Atomically (one transaction) stands up everything a brand-new user needs:
 *   - auth.users row (the global identity) + the OAuth account link
 *   - core.principal (kind 'u') sharing the SAME id as auth.users
 *   - a default core.space + its me_<slug> data schema (provisionSpace runs the
 *     schema DDL inside this transaction)
 *   - the user as space admin + owner of its home and the shared root (`share`),
 *     not owner@root
 *
 * Because schema creation is transactional, any failure rolls the whole thing
 * back — no orphaned me_<slug> schema, no cleanup code. No API key is minted:
 * keys are agent-only; humans reach the engine via their session.
 *
 * Requires a single connection that can write the auth, core, and me_<slug>
 * schemas (the DB must already be bootstrapped with the required extensions).
 */
export interface ProvisionUserParams {
  email: string;
  /** Display name, stored on auth.users. */
  name: string;
  provider: OAuthProvider;
  /** The provider's stable account id (the OAuth `sub`). */
  accountId: string;
  emailVerified?: boolean;
  image?: string;
  /** Name for the personal space (default "default"). */
  spaceName?: string;
}

export interface ProvisionUserResult {
  userId: string;
  spaceId: string;
  spaceSlug: string;
}

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
  // best-effort (a no-op once nothing is pending), and the email is one the
  // identity provider verified. This is the new home of the redemption that the
  // retired device-flow callback used to run on each sign-in.
  await redeemInvitationsForVerifiedLogin(core, params.userId, params.email);
}

export function provisionUser(
  sql: Sql,
  schemas: { auth: string; core: string },
  params: ProvisionUserParams,
): Promise<ProvisionUserResult> {
  const slug = generateSlug();

  return sql.begin(async (tx) => {
    const auth = authStore(tx as unknown as Sql, schemas.auth);
    const core = engineCore.coreStore(tx as unknown as Sql, schemas.core);

    const userId = await auth.createUser(params.email, params.name, {
      emailVerified: params.emailVerified,
      image: params.image,
    });
    await auth.upsertAccount(userId, params.provider, params.accountId);

    // The core principal shares the auth user id (one identity across schemas).
    // Its globally-unique principal name is the email — the natural unique
    // handle for a user (display name lives on auth.users.name).
    await core.createUser(userId, params.email);

    const spaceId = await core.createSpace(slug, params.spaceName ?? "default");
    await provisionSpace(tx, { slug }); // creates the me_<slug> data schema
    await addSpaceCreator(core, spaceId, userId);

    return { userId, spaceId, spaceSlug: slug };
  }) as Promise<ProvisionUserResult>;
}
