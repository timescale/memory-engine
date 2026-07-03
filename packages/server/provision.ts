import { SHARE_NAMESPACE } from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import { DEFAULT_GROUP_NAME } from "@memory.build/protocol";
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
 * The access shape a new space is provisioned with (custom spaces).
 * Resolved from the `space.create` flags; `space.ensureDefault` and the test
 * helpers use {@link DEFAULT_SPACE_CREATOR_OPTIONS} (today's conventions).
 */
export interface SpaceCreatorOptions {
  /** false → joiners (and the creator) get no owner@~; the creator gets god mode instead. */
  autoGrantHome: boolean;
  /** The default/invite group's name, or null to provision none. */
  defaultGroupName: string | null;
  /** When a default group is provisioned, whether to seed read@/share + write@/share/projects. */
  defaultGroupGrants: boolean;
}

/** Today's conventions: home grants on, a granted "team" default group. */
export const DEFAULT_SPACE_CREATOR_OPTIONS: SpaceCreatorOptions = {
  autoGrantHome: true,
  defaultGroupName: DEFAULT_GROUP_NAME,
  defaultGroupGrants: true,
};

/**
 * Stand up a new space's defaults — shared by `space.create` and
 * `space.ensureDefault` so the two stay in lockstep.
 *
 * The creator is ALWAYS a space admin (so it can self-grant and reshape access
 * however it likes); this only sets its DEFAULT tree access:
 * - Standard (`autoGrantHome`): admin + owner@~ (seeded by add_principal_to_space,
 *   which reads the space's auto_grant_home) + owner@/share (explicit). It sees
 *   `/share` and its own `~`, not other members' homes.
 * - God mode (`!autoGrantHome`): admin + owner@/ (owner@root, the whole space).
 *   add_principal_to_space seeds no owner@~ (home grants are off), so god mode
 *   grants the whole tree instead — which subsumes `~` + `/share`.
 *
 * A default group is provisioned unless `defaultGroupName` is null;
 * `defaultGroupGrants` controls whether it is seeded with the standard grants.
 * The group starts memberless, so its grants are dormant until members join.
 *
 * Requires the space row to already carry the resolved `auto_grant_home`
 * (create_space sets it before this runs), since add_principal_to_space reads it.
 * Call inside the space-creation transaction.
 */
export async function addSpaceCreator(
  core: engineCore.CoreStore,
  spaceId: string,
  userId: string,
  opts: SpaceCreatorOptions = DEFAULT_SPACE_CREATOR_OPTIONS,
): Promise<void> {
  // Always an admin; owner@~ is seeded here iff the space has auto_grant_home.
  await core.addPrincipalToSpace(spaceId, userId, true);
  if (opts.autoGrantHome) {
    await core.grantTreeAccess(
      spaceId,
      userId,
      SHARE_NAMESPACE,
      engineCore.ACCESS.owner,
    );
  } else {
    // god mode: owner@root (the whole space), which subsumes ~ + /share.
    await core.grantTreeAccess(
      spaceId,
      userId,
      engineCore.ROOT_PATH,
      engineCore.ACCESS.owner,
    );
  }
  if (opts.defaultGroupName !== null) {
    await core.provisionDefaultGroup(
      spaceId,
      opts.defaultGroupName,
      opts.defaultGroupGrants,
    );
  }
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
