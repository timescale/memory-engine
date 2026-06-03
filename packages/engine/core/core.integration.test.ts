// Integration test for the core control-plane store additions (4C-2a):
// principal listing/rename/delete, group membership listing, grant listing,
// and api-key read/delete. Runs against a real core schema.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 packages/engine/core/core.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { migrateCore } from "@memory.build/database";
import postgres, { type Sql } from "postgres";
import { type CoreStore, coreStore } from "./db";
import { ACCESS } from "./types";

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

let sql: Sql;
let coreSchema: string;
let core: CoreStore;

// Fresh space + owner user per test.
let spaceId: string;
let userId: string;
let userName: string;

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

beforeEach(async () => {
  spaceId = await core.createSpace(rand(12), "Test Space");
  userId = await v7();
  userName = `user_${rand(8)}@example.com`;
  await core.createUser(userId, userName);
  await core.addPrincipalToSpace(spaceId, userId, true);
});

test("getUserByName resolves a global user", async () => {
  const u = await core.getUserByName(userName);
  expect(u?.id).toBe(userId);
  expect(u?.kind).toBe("u");
  expect(await core.getUserByName("nobody@example.com")).toBeNull();
});

test("renamePrincipal refuses to rename users", async () => {
  expect(await core.renamePrincipal(userId, "new@example.com")).toBe(false);
  // the user's name is unchanged
  expect((await core.getPrincipal(userId))?.name).toBe(userName);
});

test("listSpaceMembers lists direct members with admin flag and kind filter", async () => {
  const all = await core.listSpaceMembers(spaceId);
  expect(all).toHaveLength(1);
  expect(all[0]?.id).toBe(userId);
  expect(all[0]?.direct).toBe(true);
  expect(all[0]?.admin).toBe(true);

  expect(await core.listSpaceMembers(spaceId, "u")).toHaveLength(1);
  expect(await core.listSpaceMembers(spaceId, "g")).toHaveLength(0);
});

test("listSpaceMembers includes group-only members (flagged direct=false)", async () => {
  // a second user who is NOT added to the space directly, only via a group
  const groupOnlyId = await v7();
  await core.createUser(groupOnlyId, `grouponly_${rand(8)}@example.com`);
  const groupId = await core.createGroup(spaceId, "team");
  await core.addGroupMember(spaceId, groupId, groupOnlyId);

  const members = await core.listSpaceMembers(spaceId, "u");
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  // owner is a direct member
  expect(byId[userId]?.direct).toBe(true);
  // the group-only user shows up as a member, flagged direct=false
  expect(byId[groupOnlyId]).toBeDefined();
  expect(byId[groupOnlyId]?.direct).toBe(false);
  expect(byId[groupOnlyId]?.admin).toBe(false);
});

test("agents appear as space members of kind 'a'", async () => {
  const agentId = await core.createAgent(userId, `agent-${rand(6)}`);
  await core.addPrincipalToSpace(spaceId, agentId);
  const agents = await core.listSpaceMembers(spaceId, "a");
  expect(agents).toHaveLength(1);
  expect(agents[0]?.id).toBe(agentId);
  expect(agents[0]?.ownerId).toBe(userId);
});

test("groups: create, list, rename, members, delete", async () => {
  const groupId = await core.createGroup(spaceId, "eng");
  let groups = await core.listSpaceGroups(spaceId);
  expect(groups.map((g) => g.name)).toContain("eng");

  expect(await core.renamePrincipal(groupId, "engineering")).toBe(true);
  groups = await core.listSpaceGroups(spaceId);
  expect(groups.find((g) => g.id === groupId)?.name).toBe("engineering");

  await core.addGroupMember(spaceId, groupId, userId, true);
  const members = await core.listGroupMembers(spaceId, groupId);
  expect(members).toHaveLength(1);
  expect(members[0]?.memberId).toBe(userId);
  expect(members[0]?.admin).toBe(true);

  const forMember = await core.listGroupsForMember(spaceId, userId);
  expect(forMember.map((g) => g.groupId)).toContain(groupId);

  expect(await core.removeGroupMember(spaceId, groupId, userId)).toBe(true);
  expect(await core.listGroupMembers(spaceId, groupId)).toHaveLength(0);

  expect(await core.deletePrincipal(groupId)).toBe(true);
  expect(await core.listSpaceGroups(spaceId)).toHaveLength(0);
});

test("listTreeAccessGrants returns grants; filterable by principal", async () => {
  await core.grantTreeAccess(spaceId, userId, "a.b", ACCESS.write);
  await core.grantTreeAccess(spaceId, userId, "c", ACCESS.owner);

  const all = await core.listTreeAccessGrants(spaceId);
  const paths = all.map((g) => g.treePath).sort();
  expect(paths).toEqual(["a.b", "c"]);
  expect(all.find((g) => g.treePath === "c")?.access).toBe(ACCESS.owner);

  const forUser = await core.listTreeAccessGrants(spaceId, userId);
  expect(forUser).toHaveLength(2);

  expect(await core.removeTreeAccessGrant(spaceId, userId, "a.b")).toBe(true);
  expect(await core.listTreeAccessGrants(spaceId)).toHaveLength(1);
});

test("api keys: create, get, list, delete (no secret leaked)", async () => {
  const key = await core.createApiKey(userId, "ci");
  expect(key.secret).toBeTruthy();

  const got = await core.getApiKey(key.id);
  expect(got?.id).toBe(key.id);
  expect(got?.memberId).toBe(userId);
  expect(got?.lookupId).toBe(key.lookupId);
  expect(got?.name).toBe("ci");
  // metadata only — no secret field on ApiKeyInfo
  expect((got as unknown as Record<string, unknown>).secret).toBeUndefined();

  const list = await core.listApiKeys(userId);
  expect(list.map((k) => k.id)).toContain(key.id);

  expect(await core.deleteApiKey(key.id)).toBe(true);
  expect(await core.getApiKey(key.id)).toBeNull();
  expect(await core.listApiKeys(userId)).toHaveLength(0);
});
