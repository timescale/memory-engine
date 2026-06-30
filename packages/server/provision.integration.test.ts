// Integration test for first-login provisioning (ensureUserProvisioned) — the
// real runtime path: better-auth owns the auth.users row, and this stands up the
// core principal on the first user RPC. It deliberately does NOT create a default
// space anymore — a personal space is provisioned explicitly via
// space.ensureDefault at onboarding (so an invitee who joins doesn't get a junk
// space). Core-only: no auth schema involved.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 packages/server/provision.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrateCore } from "@memory.build/database";
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

async function newUserId(): Promise<string> {
  const [r] = await sql`select uuidv7() as id`;
  return r?.id as string;
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand()}`;
  await migrateCore(sql, { schema: coreSchema });
});

afterAll(async () => {
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

test("provisions the core principal for a new user — and NO default space", async () => {
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
  expect(principal?.name).toBe(e);

  // No space is provisioned lazily anymore — that's space.ensureDefault's job,
  // called explicitly at onboarding only when the user has zero spaces.
  expect(await core.listSpacesForMember(userId)).toHaveLength(0);
});

test("is idempotent: a second call is a no-op (no duplicate principal)", async () => {
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
  // Re-running must not throw or change anything.
  await ensureUserProvisioned(
    sql,
    core,
    { core: coreSchema },
    {
      userId,
      email: e,
    },
  );

  const principal = await core.getPrincipal(userId);
  expect(principal?.id).toBe(userId);
  expect(await core.listSpacesForMember(userId)).toHaveLength(0);
});
