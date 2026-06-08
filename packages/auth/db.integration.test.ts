// Integration tests for the auth runtime layer (authStore).
//
// Provisions a throwaway auth_test_<rand> schema via migrateAuth and exercises
// the wrappers against the real SQL functions.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 packages/auth/db.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrateAuth } from "@memory.build/database";
import postgres, { type Sql } from "postgres";
import { type AuthStore, authStore } from "./db";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomAuthSchema = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 36];
  return `auth_test_${s}`;
};
const email = () => `fn_${crypto.randomUUID().slice(0, 8)}@example.com`;

let sql: Sql;
let schema: string;
let db: AuthStore;

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  schema = randomAuthSchema();
  await migrateAuth(sql, { schema });
  db = authStore(sql, schema);
});

afterAll(async () => {
  if (schema) await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.end();
});

test("createUser + getUser + getUserByEmail (case-insensitive)", async () => {
  const e = email();
  const id = await db.createUser(e, "Alice", { emailVerified: true });

  const byId = await db.getUser(id);
  expect(byId?.id).toBe(id);
  expect(byId?.email).toBe(e);
  expect(byId?.emailVerified).toBe(true);

  const byEmail = await db.getUserByEmail(e.toUpperCase());
  expect(byEmail?.id).toBe(id);

  expect(await db.getUserByEmail(email())).toBeNull();
});

test("createSession returns a token that validateSession accepts", async () => {
  const id = await db.createUser(email(), "Bob");
  const { sessionId, token } = await db.createSession(id);
  expect(token.length).toBeGreaterThan(20);

  const v = await db.validateSession(token);
  expect(v?.sessionId).toBe(sessionId);
  expect(v?.userId).toBe(id);

  // wrong token → null
  expect(await db.validateSession("not-a-real-token")).toBeNull();

  // after delete → null
  expect(await db.deleteSession(sessionId)).toBe(true);
  expect(await db.validateSession(token)).toBeNull();
});

test("validateSession rolls a near-expiry session forward, then throttles", async () => {
  const id = await db.createUser(email(), "Rolling");
  // Start with a 1-day session so it's inside the refresh threshold (<6d left).
  const { token } = await db.createSession(id, { expiresInDays: 1 });

  // First use slides the expiry forward to ~7 days out (the window).
  const before = await db.validateSession(token);
  expect(before).not.toBeNull();
  const sixDaysOut = Date.now() + 6 * 24 * 60 * 60 * 1000;
  expect(before?.expiresAt.getTime()).toBeGreaterThan(sixDaysOut);

  // A full-window session is NOT bumped again on the next use (≤ once/day
  // throttle): the stored expiry is unchanged, not sliding on every call.
  const after = await db.validateSession(token);
  expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
});

test("deleteSessionsByUser revokes all of a user's sessions", async () => {
  const id = await db.createUser(email(), "Carol");
  const a = await db.createSession(id);
  const b = await db.createSession(id);

  expect(await db.deleteSessionsByUser(id)).toBe(2);
  expect(await db.validateSession(a.token)).toBeNull();
  expect(await db.validateSession(b.token)).toBeNull();
});

test("upsertAccount + getAccountByProvider", async () => {
  const id = await db.createUser(email(), "Dave");
  const acct = crypto.randomUUID();

  await db.upsertAccount(id, "github", acct);
  const found = await db.getAccountByProvider("github", acct);
  expect(found?.userId).toBe(id);
  expect(found?.providerId).toBe("github");

  // idempotent
  await db.upsertAccount(id, "github", acct);
  expect((await db.getAccountsByUser(id)).length).toBe(1);

  expect(
    await db.getAccountByProvider("github", crypto.randomUUID()),
  ).toBeNull();
});

test("device flow: create → lookup (normalized code) → poll → authorize", async () => {
  const id = await db.createUser(email(), "Erin");
  const { deviceCode, userCode, oauthState } =
    await db.createDeviceAuth("google");

  // user_code lookup tolerates lowercase / missing hyphen
  const denorm = userCode.toLowerCase().replace("-", "");
  const byUserCode = await db.getDeviceByUserCode(denorm);
  expect(byUserCode?.deviceCode).toBe(deviceCode);

  const byState = await db.getDeviceByOAuthState(oauthState);
  expect(byState?.deviceCode).toBe(deviceCode);

  // pending → bind (callback) → still pending → approve (consent) → authorized
  expect((await db.pollDevice(deviceCode, 0)).status).toBe("pending");
  expect(await db.bindDeviceUser(deviceCode, id)).toBe(true);
  expect((await db.pollDevice(deviceCode, 0)).status).toBe("pending");
  expect(await db.approveDevice(deviceCode)).toBe(true);
  const poll = await db.pollDevice(deviceCode, 0);
  expect(poll.status).toBe("approved");
  expect(poll.userId).toBe(id);
});

test("withTransaction rolls back on error", async () => {
  const e = email();
  await expect(
    db.withTransaction(async (tx) => {
      await tx.createUser(e, "Rollback");
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await db.getUserByEmail(e)).toBeNull();
});
