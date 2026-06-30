import { SHARE_NAMESPACE } from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import type { Sql } from "postgres";

/**
 * First-login provisioning (core side).
 *
 * better-auth owns the `auth.users` + `accounts` rows (created on social login).
 * This module stands up the matching core side — a `core.principal` sharing the
 * auth user id — lazily on the first authenticated user RPC (see
 * {@link ensureUserProvisioned}). A personal space is NOT created here; it is
 * provisioned explicitly via `space.ensureDefault` at onboarding.
 */

/**
 * Grant a new space's creator its default access — shared by `space.create` and
 * `space.ensureDefault` so the two stay in lockstep. The creator
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

export interface EnsureProvisionedParams {
  /** The authenticated user id (== auth.users.id == core.principal.id). */
  userId: string;
  /** The user's email — the globally-unique core principal name. */
  email: string;
}

/**
 * Lazy, idempotent core-side provisioning for a better-auth user.
 *
 * better-auth owns the `auth.users` + `accounts` rows; this stands up the
 * matching `core.principal` (sharing the auth user id) the first time an
 * authenticated user is seen on the user RPC. It deliberately does **NOT** create
 * a default space: a personal space is provisioned explicitly via
 * `space.ensureDefault`, called by the onboarding entry points (CLI `me login`,
 * web AuthGate) only when the user has zero spaces — so a user who joins via an
 * accepted invitation or a redeemed magic link never gets a junk personal space
 * (the join-by-link path is not email-keyed, so it can't be detected here).
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
  // Provision the core principal on first sight (idempotent); skip when done.
  if (await core.getPrincipal(params.userId)) return;
  try {
    await sql.begin(async (tx) => {
      const txCore = engineCore.coreStore(tx as unknown as Sql, schemas.core);
      // Re-check inside the transaction to narrow the provisioning race window.
      if (await txCore.getPrincipal(params.userId)) return;
      // Principal name is the email (its unique handle); display name lives on
      // the better-auth user row.
      await txCore.createUser(params.userId, params.email);
    });
  } catch (error) {
    // A concurrent first-request may have provisioned us first. If the
    // principal now exists the race resolved in our favor; else re-throw.
    if (!(await core.getPrincipal(params.userId))) throw error;
  }
}
