// Integration test for first-login provisioning (ensureUserProvisioned) — the
// real runtime path: better-auth owns the auth.users row, and this stands up the
// core side (principal + default space + creator grants) on the first user RPC.
// Core-only: no auth schema involved.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 packages/server/provision.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { bootstrapSpaceDatabase, migrateCore } from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import postgres, { type Sql } from "postgres";
import { ensureUserProvisioned } from "./provision";

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
let coreSchema: string;
const createdSpaceSchemas: string[] = [];

async function newUserId(): Promise<string> {
  const [r] = await sql`select uuidv7() as id`;
  return r?.id as string;
}

async function schemaExists(name: string): Promise<boolean> {
  const [r] = await sql`
    select exists (
      select 1 from information_schema.schemata where schema_name = ${name}
    ) as e`;
  return Boolean(r?.e);
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand()}`;
  await bootstrapSpaceDatabase(sql); // extensions for me_<slug>
  await migrateCore(sql, { schema: coreSchema });
});

afterAll(async () => {
  for (const s of createdSpaceSchemas) {
    await sql.unsafe(`drop schema if exists ${s} cascade`);
  }
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

test("provisions the core side for a new user: principal + space + creator grants", async () => {
  const userId = await newUserId();
  const e = email();
  const core = engineCore.coreStore(sql, coreSchema);

  await ensureUserProvisioned(
    sql,
    core,
    { core: coreSchema },
    {
      userId,
      email: e,
    },
  );

  // core principal shares the auth user id; its name is the email
  const principal = await core.getPrincipal(userId);
  expect(principal?.kind).toBe("u");
  expect(principal?.id).toBe(userId);

  // exactly one space, registered in core + its data schema exists
  const spaces = await core.listSpacesForMember(userId);
  expect(spaces).toHaveLength(1);
  const space = spaces[0];
  if (!space) throw new Error("expected a provisioned space");
  createdSpaceSchemas.push(`me_${space.slug}`);
  expect(await schemaExists(`me_${space.slug}`)).toBe(true);

  // the creator's default grants: owner of its home + the shared root (`share`),
  // but NOT owner@root
  const ta = await core.buildTreeAccess(userId, space.id);
  expect(ta).toContainEqual({
    tree_path: "share",
    access: engineCore.ACCESS.owner,
  });
  expect(ta).toContainEqual({
    tree_path: `home.${userId.replace(/-/g, "")}`,
    access: engineCore.ACCESS.owner,
  });
  expect(ta).not.toContainEqual({
    tree_path: engineCore.ROOT_PATH,
    access: engineCore.ACCESS.owner,
  });
});

test("is idempotent: a second call is a no-op (no duplicate principal/space)", async () => {
  const userId = await newUserId();
  const e = email();
  const core = engineCore.coreStore(sql, coreSchema);

  await ensureUserProvisioned(
    sql,
    core,
    { core: coreSchema },
    {
      userId,
      email: e,
    },
  );
  const after1 = await core.listSpacesForMember(userId);
  expect(after1).toHaveLength(1);
  const first = after1[0];
  if (first) createdSpaceSchemas.push(`me_${first.slug}`);

  // Re-running must not throw, mint a second space, or duplicate the principal.
  await ensureUserProvisioned(
    sql,
    core,
    { core: coreSchema },
    {
      userId,
      email: e,
    },
  );
  const after2 = await core.listSpacesForMember(userId);
  expect(after2).toHaveLength(1);
  expect(after2[0]?.slug).toBe(first?.slug);
});
