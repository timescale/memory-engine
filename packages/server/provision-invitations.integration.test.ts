// Integration test for invitation redemption on a verified login:
// redeemInvitationsForVerifiedLogin joins a user to every space they were
// invited to, and swallows failures so a redemption hiccup never breaks the
// request. The redeem SQL/store itself is covered in the engine + migrate
// suites; here we cover the provisioning-side glue against a real core schema.
// (Moved from the retired device-flow handler; the function now lives in
// provision.ts and is driven by ensureUserProvisioned.)
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/provision-invitations.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrateCore } from "@memory.build/database";
import { ACCESS, type CoreStore, coreStore } from "@memory.build/engine/core";
import postgres, { type Sql } from "postgres";
import { redeemInvitationsForVerifiedLogin } from "./provision";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const rand = (n: number) => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of bytes) s += a[b % 36];
  return s;
};
const randomSlug = () => rand(12);

let sql: Sql;
let coreSchema: string;
let core: CoreStore;

async function v7(): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  return row?.id as string;
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand(8)}`;
  await migrateCore(sql, { schema: coreSchema });
  core = coreStore(sql, coreSchema);
});

afterAll(async () => {
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

test("redeems pending invitations for a verified-login email", async () => {
  const spaceId = await core.createSpace(randomSlug(), "Invited Space");
  const inviterId = await v7();
  await core.createUser(inviterId, `inviter_${rand(8)}@example.com`);

  const email = `invitee_${rand(8)}@example.com`;
  await core.createSpaceInvitation(spaceId, email, {
    admin: true,
    shareAccess: ACCESS.write,
    invitedBy: inviterId,
  });

  // the user already exists in core (ensureUserProvisioned stands up the
  // principal before reaching the redemption step)
  const userId = await v7();
  await core.createUser(userId, email);

  const joined = await redeemInvitationsForVerifiedLogin(core, userId, email);
  expect(joined).toBe(1);

  // joined the space as admin, with owner@home + write@share
  const principals = await core.listSpacePrincipals(spaceId);
  expect(principals.find((p) => p.id === userId)?.admin).toBe(true);
  const ta = await core.buildTreeAccess(userId, spaceId);
  expect(ta).toContainEqual({
    tree_path: `home.${userId.replace(/-/g, "")}`,
    access: ACCESS.owner,
  });
  expect(ta).toContainEqual({ tree_path: "share", access: ACCESS.write });

  // invitation consumed; a second login is a no-op
  expect(await core.listSpaceInvitations(spaceId)).toHaveLength(0);
  expect(await redeemInvitationsForVerifiedLogin(core, userId, email)).toBe(0);
});

test("best-effort: a redemption failure is swallowed (does not throw)", async () => {
  const spaceId = await core.createSpace(randomSlug(), "Space");
  const inviterId = await v7();
  await core.createUser(inviterId, `inviter_${rand(8)}@example.com`);
  const email = `ghost_${rand(8)}@example.com`;
  await core.createSpaceInvitation(spaceId, email, {
    admin: false,
    shareAccess: ACCESS.read,
    invitedBy: inviterId,
  });

  // a user id that is not a core principal → add_principal_to_space FK fails
  // inside redeem; the helper must swallow the error and report zero joins.
  const orphanUserId = await v7();
  const joined = await redeemInvitationsForVerifiedLogin(
    core,
    orphanUserId,
    email,
  );
  expect(joined).toBe(0);

  // the failed redemption rolled back atomically: the invite is still pending
  expect(await core.listSpaceInvitations(spaceId)).toHaveLength(1);
});
