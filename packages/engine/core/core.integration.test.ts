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

test("listSpacePrincipals lists direct principals with admin flag and kind filter", async () => {
  const all = await core.listSpacePrincipals(spaceId);
  expect(all).toHaveLength(1);
  expect(all[0]?.id).toBe(userId);
  expect(all[0]?.direct).toBe(true);
  expect(all[0]?.admin).toBe(true);

  expect(await core.listSpacePrincipals(spaceId, "u")).toHaveLength(1);
  expect(await core.listSpacePrincipals(spaceId, "g")).toHaveLength(0);
});

test("listSpacePrincipals includes group-only principals (flagged direct=false)", async () => {
  // a second user who is NOT added to the space directly, only via a group
  const groupOnlyId = await v7();
  await core.createUser(groupOnlyId, `grouponly_${rand(8)}@example.com`);
  const groupId = await core.createGroup(spaceId, "team");
  await core.addGroupMember(spaceId, groupId, groupOnlyId);

  const members = await core.listSpacePrincipals(spaceId, "u");
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
  const agents = await core.listSpacePrincipals(spaceId, "a");
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

test("space admin transfers through an admin group", async () => {
  const groupId = await core.createGroup(spaceId, `admins_${rand(6)}`);
  // designate the group itself as an admin member of the space
  await core.addPrincipalToSpace(spaceId, groupId, true);

  // a user added only to that group inherits space-admin transitively
  const member = await v7();
  await core.createUser(member, `m_${rand(8)}@example.com`);
  await core.addGroupMember(spaceId, groupId, member);
  expect(await core.isSpaceAdmin(member, spaceId)).toBe(true);

  // a non-member is not an admin
  const stranger = await v7();
  await core.createUser(stranger, `s_${rand(8)}@example.com`);
  expect(await core.isSpaceAdmin(stranger, spaceId)).toBe(false);
});

test("group grants are inherited transitively (Model 2)", async () => {
  // a user who is ONLY a group member (no direct principal_space row, no direct
  // grant) inherits the group's grant via build_tree_access.
  const groupOnly = await v7();
  await core.createUser(groupOnly, `go_${rand(8)}@example.com`);
  const groupId = await core.createGroup(spaceId, `grp_${rand(6)}`);
  await core.addGroupMember(spaceId, groupId, groupOnly);
  await core.grantTreeAccess(spaceId, groupId, "shared", ACCESS.write);

  const ta = await core.buildTreeAccess(groupOnly, spaceId);
  expect(ta).toContainEqual({ tree_path: "shared", access: ACCESS.write });
});

test("listTreeAccessGrants returns grants; filterable by principal", async () => {
  await core.grantTreeAccess(spaceId, userId, "a.b", ACCESS.write);
  await core.grantTreeAccess(spaceId, userId, "c", ACCESS.owner);

  // the owner also has owner@home, granted when it joined the space (beforeEach)
  const home = `home.${userId.replace(/-/g, "")}`;

  const all = await core.listTreeAccessGrants(spaceId);
  const paths = all.map((g) => g.treePath).sort();
  expect(paths).toEqual([home, "a.b", "c"].sort());
  expect(all.find((g) => g.treePath === "c")?.access).toBe(ACCESS.owner);

  const forUser = await core.listTreeAccessGrants(spaceId, userId);
  expect(forUser).toHaveLength(3);

  expect(await core.removeTreeAccessGrant(spaceId, userId, "a.b")).toBe(true);
  expect(await core.listTreeAccessGrants(spaceId)).toHaveLength(2);
});

test("space invitations: create / list / redeem / revoke via the store", async () => {
  // spaceId + the owner userId come from beforeEach; the owner is the inviter
  const email = `invitee_${rand(8)}@example.com`;
  const inviteId = await core.createSpaceInvitation(spaceId, email, {
    admin: true,
    shareAccess: ACCESS.write,
    invitedBy: userId,
  });
  expect(inviteId).toBeTruthy();

  const pending = await core.listSpaceInvitations(spaceId);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.email).toBe(email);
  expect(pending[0]?.admin).toBe(true);
  expect(pending[0]?.shareAccess).toBe(ACCESS.write);
  expect(pending[0]?.invitedBy).toBe(userId);
  expect(pending[0]?.invitedByName).toBe(userName);

  // the invitee registers and redeems
  const inviteeId = await v7();
  await core.createUser(inviteeId, email);
  const joined = await core.redeemSpaceInvitations(inviteeId, email);
  expect(joined).toHaveLength(1);
  expect(joined[0]?.spaceId).toBe(spaceId);
  expect(joined[0]?.slug).toBeTruthy();
  expect(joined[0]?.admin).toBe(true);
  expect(joined[0]?.shareAccess).toBe(ACCESS.write);

  // effective access: owner@home (from joining) + write@share
  const ta = await core.buildTreeAccess(inviteeId, spaceId);
  expect(ta).toContainEqual({
    tree_path: `home.${inviteeId.replace(/-/g, "")}`,
    access: ACCESS.owner,
  });
  expect(ta).toContainEqual({ tree_path: "share", access: ACCESS.write });

  // accepted → no longer pending; re-redeem is a no-op
  expect(await core.listSpaceInvitations(spaceId)).toHaveLength(0);
  expect(await core.redeemSpaceInvitations(inviteeId, email)).toHaveLength(0);

  // a fresh invite (with no share grant) is revocable once
  await core.createSpaceInvitation(spaceId, email, {
    admin: false,
    shareAccess: null,
    invitedBy: userId,
  });
  expect(await core.revokeSpaceInvitation(spaceId, email)).toBe(true);
  expect(await core.revokeSpaceInvitation(spaceId, email)).toBe(false);
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

// ---------------------------------------------------------------------------
// last-admin safeguard (enforce_last_admin trigger on principal_space)
// ---------------------------------------------------------------------------

/** Assert a promise rejects with the last-admin guard's SQLSTATE (ME001). */
async function expectLastAdmin(p: Promise<unknown>) {
  try {
    await p;
    throw new Error("expected a last-admin (ME001) rejection, but it resolved");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("ME001");
  }
}

test("removing the last admin is rejected (ME001)", async () => {
  // beforeEach made userId the space's sole admin.
  await expectLastAdmin(core.removePrincipalFromSpace(spaceId, userId));
  // rolled back — the admin is still a member
  const all = await core.listSpacePrincipals(spaceId);
  expect(all.find((p) => p.id === userId)?.admin).toBe(true);
});

test("demoting the last admin is rejected (ME001)", async () => {
  await expectLastAdmin(core.addPrincipalToSpace(spaceId, userId, false));
  const all = await core.listSpacePrincipals(spaceId);
  expect(all.find((p) => p.id === userId)?.admin).toBe(true);
});

test("removing a non-last admin succeeds (another admin remains)", async () => {
  const user2 = await v7();
  await core.createUser(user2, `admin2_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(spaceId, user2, true); // 2nd admin

  expect(await core.removePrincipalFromSpace(spaceId, userId)).toBe(true);
  const admins = (await core.listSpacePrincipals(spaceId)).filter(
    (p) => p.admin,
  );
  expect(admins.map((p) => p.id)).toEqual([user2]);
});

test("deleting a group that is the space's only admin is rejected (ME001)", async () => {
  // a fresh space whose sole effective admin is a user via an admin group
  const sid = await core.createSpace(rand(12), "Group-admin Space");
  const groupId = await core.createGroup(sid, `admins_${rand(6)}`);
  await core.addPrincipalToSpace(sid, groupId, true);
  const member = await v7();
  await core.createUser(member, `gm_${rand(8)}@example.com`);
  await core.addGroupMember(sid, groupId, member); // effective admin via the group

  await expectLastAdmin(core.deletePrincipal(groupId));
  // rolled back — the group is still the space's admin
  const admins = (await core.listSpacePrincipals(sid)).filter((p) => p.admin);
  expect(admins.map((p) => p.id)).toContain(groupId);
});

test("removing the last member of the sole admin group is rejected (ME001)", async () => {
  const sid = await core.createSpace(rand(12), "Group-admin Space");
  const groupId = await core.createGroup(sid, `admins_${rand(6)}`);
  await core.addPrincipalToSpace(sid, groupId, true); // group holds space-admin
  const member = await v7();
  await core.createUser(member, `gm_${rand(8)}@example.com`);
  await core.addGroupMember(sid, groupId, member); // sole effective admin

  // emptying the admin group leaves no effective admin
  await expectLastAdmin(core.removeGroupMember(sid, groupId, member));
  expect(
    (await core.listGroupMembers(sid, groupId)).map((m) => m.memberId),
  ).toEqual([member]);

  // with a direct admin also present, removing the group member is fine
  const direct = await v7();
  await core.createUser(direct, `direct_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, direct, true);
  expect(await core.removeGroupMember(sid, groupId, member)).toBe(true);
});

test("an empty admin group is not an effective admin (the brick is closed)", async () => {
  const sid = await core.createSpace(rand(12), "Brick Space");
  const direct = await v7();
  await core.createUser(direct, `creator_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, direct, true); // the only real admin
  const emptyGroup = await core.createGroup(sid, `empties_${rand(6)}`);
  await core.addPrincipalToSpace(sid, emptyGroup, true); // admin flag, no members

  // the empty admin group confers admin on nobody, so removing the direct admin
  // would leave the space ungoverned — rejected.
  await expectLastAdmin(core.removePrincipalFromSpace(sid, direct));
  const admins = (await core.listSpacePrincipals(sid))
    .filter((p) => p.admin)
    .map((p) => p.id)
    .sort();
  expect(admins).toEqual([direct, emptyGroup].sort());
});

test("deleting the whole space is exempt from the guard (teardown)", async () => {
  // a fresh space with a single admin — deleting the space drops the roster via
  // FK cascade, which must NOT trip the last-admin guard.
  const slug = rand(12);
  const sid = await core.createSpace(slug, "Doomed Space");
  const admin = await v7();
  await core.createUser(admin, `doomed_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, admin, true);

  expect(await core.deleteSpace(slug)).toBe(true);
  expect(await core.getSpace(slug)).toBeNull();
});
