// Integration tests for the core control-plane TS layer (coreStore).
//
// Provisions a throwaway `core_test_<rand>` schema via migrateCore and exercises
// the thin wrappers against the real SQL functions. Run with a database, e.g.:
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 packages/engine/core/db.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrateCore } from "@memory.build/database";
import postgres, { type Sql } from "postgres";
import { formatApiKey, parseApiKey } from "./api-key";
import { type CoreStore, coreStore } from "./db";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomFrom(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 36];
  return s;
}
const randomCoreSchema = () => `core_test_${randomFrom(8)}`;
const randomSlug = () => randomFrom(12);

let sql: Sql;
let schema: string;
let db: CoreStore;

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  schema = randomCoreSchema();
  await migrateCore(sql, { schema });
  db = coreStore(sql, schema);
});

afterAll(async () => {
  if (schema) await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.end();
});

/** A fresh uuidv7 (principal.id requires version 7, = the future auth.users.id). */
async function newUserId(): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  return row?.id as string;
}

test("createSpace + getSpace round-trips", async () => {
  const slug = randomSlug();
  const id = await db.createSpace(slug, "My Space");
  expect(id).toBeTruthy();

  const space = await db.getSpace(slug);
  expect(space?.id).toBe(id);
  expect(space?.name).toBe("My Space");
  expect(space?.language).toBe("english");

  expect(await db.getSpace(randomSlug())).toBeNull();
});

test("createUser + getPrincipal", async () => {
  const userId = await newUserId();
  await db.createUser(userId, `alice_${userId.slice(0, 8)}`);

  const p = await db.getPrincipal(userId);
  expect(p?.id).toBe(userId);
  expect(p?.kind).toBe("u");
  expect(p?.ownerId).toBeNull();
  expect(p?.spaceId).toBeNull();
});

test("grant + buildTreeAccess returns the search_memory jsonb shape", async () => {
  const spaceId = await db.createSpace(randomSlug(), "S");
  const userId = await newUserId();
  await db.createUser(userId, `bob_${userId.slice(0, 8)}`);
  await db.addPrincipalToSpace(spaceId, userId, true);
  await db.grantTreeAccess(spaceId, userId, "work.projects", 2);

  const ta = await db.buildTreeAccess(userId, spaceId);
  // addPrincipalToSpace also grants the user owner@home.
  expect(ta).toContainEqual({ tree_path: "work.projects", access: 2 });
  expect(ta).toContainEqual({
    tree_path: `home.${userId.replace(/-/g, "")}`,
    access: 3,
  });
  expect(ta).toHaveLength(2);
});

test("group access flows through buildTreeAccess; removeGroupMember revokes it", async () => {
  const spaceId = await db.createSpace(randomSlug(), "T");
  const userId = await newUserId();
  await db.createUser(userId, `carol_${userId.slice(0, 8)}`);
  const groupId = await db.createGroup(spaceId, "eng");

  await db.addPrincipalToSpace(spaceId, userId);
  await db.addPrincipalToSpace(spaceId, groupId);
  await db.addGroupMember(spaceId, groupId, userId);
  await db.grantTreeAccess(spaceId, groupId, "shared", 1);

  expect(await db.buildTreeAccess(userId, spaceId)).toContainEqual({
    tree_path: "shared",
    access: 1,
  });

  expect(await db.removeGroupMember(spaceId, groupId, userId)).toBe(true);
  // still a space member: the group grant is gone, the user keeps its home.
  expect(await db.buildTreeAccess(userId, spaceId)).toEqual([
    { tree_path: `home.${userId.replace(/-/g, "")}`, access: 3 },
  ]);
});

test("createApiKey + validateApiKey (good / wrong secret)", async () => {
  const userId = await newUserId();
  await db.createUser(userId, `dave_${userId.slice(0, 8)}`);

  const key = await db.createApiKey(userId, "default");
  expect(key.lookupId).toMatch(/^[A-Za-z0-9_-]{16}$/);
  expect(key.secret.length).toBe(32);

  const valid = await db.validateApiKey(key.lookupId, key.secret);
  expect(valid?.memberId).toBe(userId);
  expect(valid?.apiKeyId).toBe(key.id);

  expect(await db.validateApiKey(key.lookupId, "wrong-secret")).toBeNull();
});

test("api key string format round-trips with parseApiKey", async () => {
  const userId = await newUserId();
  await db.createUser(userId, `erin_${userId.slice(0, 8)}`);
  const key = await db.createApiKey(userId, "fmt");

  const str = formatApiKey(key.lookupId, key.secret);
  expect(parseApiKey(str)).toEqual({
    lookupId: key.lookupId,
    secret: key.secret,
  });
});

test("withTransaction rolls back on error", async () => {
  const slug = randomSlug();
  await expect(
    db.withTransaction(async (tx) => {
      await tx.createSpace(slug, "Tx Space");
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  // rolled back — the space was never committed
  expect(await db.getSpace(slug)).toBeNull();
});
