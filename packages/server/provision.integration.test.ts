// Integration test for first-login provisioning (provisionUser).
//
// Stands up auth + core schemas and bootstraps the space DB in one database,
// then provisions users through a single connection (the one-pool model the
// server consolidates to in Phase 4).
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 packages/server/provision.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { authStore } from "@memory.build/auth";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import { core as engineCore } from "@memory.build/engine";
import postgres, { type Sql } from "postgres";
import { provisionUser } from "./provision";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const rand = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += a[b % 36];
  return s;
};
const email = () => `prov_${crypto.randomUUID().slice(0, 8)}@example.com`;

let sql: Sql;
let authSchema: string;
let coreSchema: string;
const createdSpaceSchemas: string[] = [];

async function schemaExists(name: string): Promise<boolean> {
  const [r] = await sql`
    select exists (
      select 1 from information_schema.schemata where schema_name = ${name}
    ) as e`;
  return Boolean(r?.e);
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  authSchema = `auth_test_${rand()}`;
  coreSchema = `core_test_${rand()}`;
  await bootstrapSpaceDatabase(sql); // extensions for me_<slug>
  await migrateAuth(sql, { schema: authSchema });
  await migrateCore(sql, { schema: coreSchema });
});

afterAll(async () => {
  for (const s of createdSpaceSchemas) {
    await sql.unsafe(`drop schema if exists ${s} cascade`);
  }
  await sql.unsafe(`drop schema if exists ${authSchema} cascade`);
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

test("provisions a new user: identity + principal + space + owner grant", async () => {
  const e = email();
  const accountId = crypto.randomUUID();
  const r = await provisionUser(
    sql,
    { auth: authSchema, core: coreSchema },
    { email: e, name: "Alice", provider: "github", accountId },
  );
  createdSpaceSchemas.push(`me_${r.spaceSlug}`);

  // auth.users
  const user = await authStore(sql, authSchema).getUser(r.userId);
  expect(user?.email).toBe(e);

  // oauth account link resolves back to the user
  const acct = await authStore(sql, authSchema).getAccountByProvider(
    "github",
    accountId,
  );
  expect(acct?.userId).toBe(r.userId);

  // core principal shares the same id
  const principal = await engineCore
    .coreStore(sql, coreSchema)
    .getPrincipal(r.userId);
  expect(principal?.kind).toBe("u");
  expect(principal?.id).toBe(r.userId);

  // space registered in core + its data schema exists
  const space = await engineCore
    .coreStore(sql, coreSchema)
    .getSpace(r.spaceSlug);
  expect(space?.id).toBe(r.spaceId);
  expect(await schemaExists(`me_${r.spaceSlug}`)).toBe(true);

  // owner of the space root
  const ta = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(r.userId, r.spaceId);
  expect(ta).toContainEqual({
    tree_path: engineCore.ROOT_PATH,
    access: engineCore.ACCESS.owner,
  });
});

test("is atomic: a failure rolls everything back", async () => {
  const e = email();
  const a1 = crypto.randomUUID();
  const r1 = await provisionUser(
    sql,
    { auth: authSchema, core: coreSchema },
    { email: e, name: "Bob", provider: "github", accountId: a1 },
  );
  createdSpaceSchemas.push(`me_${r1.spaceSlug}`);

  // re-provisioning the same email fails (users.email is unique) — the whole
  // transaction must roll back, leaving no trace of the second attempt.
  const a2 = crypto.randomUUID();
  await expect(
    provisionUser(
      sql,
      { auth: authSchema, core: coreSchema },
      { email: e, name: "Bob2", provider: "github", accountId: a2 },
    ),
  ).rejects.toThrow();

  // the second account link was rolled back
  expect(
    await authStore(sql, authSchema).getAccountByProvider("github", a2),
  ).toBeNull();
});
