import { authStore, type OAuthProvider } from "@memory.build/auth";
import { generateSlug, provisionSpace } from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import type { Sql } from "postgres";

/**
 * First-login provisioning.
 *
 * Atomically (one transaction) stands up everything a brand-new user needs:
 *   - auth.users row (the global identity) + the OAuth account link
 *   - core.principal (kind 'u') sharing the SAME id as auth.users
 *   - a default core.space + its me_<slug> data schema (provisionSpace runs the
 *     schema DDL inside this transaction)
 *   - the user's owner grant on the space root
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
    await core.addPrincipalToSpace(spaceId, userId, true);
    // owner of the root path → the user owns the whole space
    await core.grantTreeAccess(
      spaceId,
      userId,
      engineCore.ROOT_PATH,
      engineCore.ACCESS.owner,
    );

    return { userId, spaceId, spaceSlug: slug };
  }) as Promise<ProvisionUserResult>;
}
