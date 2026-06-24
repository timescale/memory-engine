/**
 * Integration-test support — seed a user + their default space.
 *
 * The new-model stand-in for the retired `provisionUser`. At runtime, better-auth
 * creates the `auth.users` row (on social login) and `ensureUserProvisioned`
 * stands up the core side lazily on the first user RPC; a test has neither a
 * browser nor a live token, so it fabricates both here. This composes the same
 * core primitives `ensureUserProvisioned` uses (principal + default space +
 * creator grants).
 *
 * Pass `auth` to also insert the better-auth `users` row — needed ONLY by tests
 * that mint a real OAuth bearer, because `verifyOAuthAccessToken` joins `users`.
 * Core-only consumers (those that build a handler context directly) omit it.
 */
import { generateSlug, provisionSpace } from "@memory.build/database";
import { coreStore } from "@memory.build/engine/core";
import type { Sql } from "postgres";
import { addSpaceCreator } from "./provision";

export interface SeededUser {
  userId: string;
  spaceId: string;
  spaceSlug: string;
}

export async function seedUserSpace(
  sql: Sql,
  schemas: { core: string; auth?: string },
  opts: { email?: string; name?: string; spaceName?: string } = {},
): Promise<SeededUser> {
  const [idRow] = await sql`select uuidv7() as id`;
  const userId = idRow?.id as string;
  const email = opts.email ?? `u_${userId.slice(0, 8)}@example.com`;
  const name = opts.name ?? "Test User";

  // The auth identity better-auth would have created at login (Group B only).
  if (schemas.auth) {
    await sql.unsafe(
      `insert into ${schemas.auth}.users (id, name, email, email_verified)
       values ($1, $2, $3, true)`,
      [userId, name, email],
    );
  }

  // The core side ensureUserProvisioned builds at runtime: principal sharing the
  // user id, a default space + its data schema, and the creator grants.
  const core = coreStore(sql, schemas.core);
  await core.createUser(userId, email);
  const spaceSlug = generateSlug();
  const spaceId = await core.createSpace(
    spaceSlug,
    opts.spaceName ?? "default",
  );
  await provisionSpace(sql, { slug: spaceSlug });
  await addSpaceCreator(core, spaceId, userId);

  return { userId, spaceId, spaceSlug };
}
