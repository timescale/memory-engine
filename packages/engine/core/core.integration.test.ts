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
  expect(all[0]?.admin).toBe(true);

  expect(await core.listSpacePrincipals(spaceId, "u")).toHaveLength(1);
  expect(await core.listSpacePrincipals(spaceId, "g")).toHaveLength(0);
});

test("listSpacePrincipals excludes group-only principals (not space members)", async () => {
  // a second user who is NOT added to the space directly, only via a group
  const groupOnlyId = await v7();
  await core.createUser(groupOnlyId, `grouponly_${rand(8)}@example.com`);
  const groupId = await core.createGroup(spaceId, "team");
  await core.addGroupMember(spaceId, groupId, groupOnlyId);

  const ids = (await core.listSpacePrincipals(spaceId, "u")).map((m) => m.id);
  // the owner is a direct member; the group-only user is not a space member
  // (group membership alone does not make you one), so it is not listed
  expect(ids).toContain(userId);
  expect(ids).not.toContain(groupOnlyId);
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

test("createGroup rosters the group into principal_space (admin=false, no home grant)", async () => {
  const groupId = await core.createGroup(spaceId, `roster_${rand(6)}`);

  // the group is on the roster as a kind 'g' principal, non-admin
  const groups = await core.listSpacePrincipals(spaceId, "g");
  expect(groups.map((g) => g.id)).toContain(groupId);
  expect(groups.find((g) => g.id === groupId)?.admin).toBe(false);

  // and it shows up in the unfiltered roster alongside the owner
  const all = await core.listSpacePrincipals(spaceId);
  expect(all.map((p) => p.id)).toContain(groupId);

  // groups get NO home grant (only users/agents do), so the group holds no
  // tree_access of its own and cannot authenticate (build_tree_access empty).
  expect(await core.listTreeAccessGrants(spaceId, groupId)).toEqual([]);
  expect(await core.buildTreeAccess(groupId, spaceId)).toEqual([]);
});

test("addGroupMember rejects a group as a member (groups are not nestable)", async () => {
  const groupId = await core.createGroup(spaceId, `g1_${rand(6)}`);
  const nested = await core.createGroup(spaceId, `g2_${rand(6)}`);

  let err: unknown;
  try {
    await core.addGroupMember(spaceId, groupId, nested);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(String(err)).toContain("not nestable");

  // the rejected nesting left no group_member row behind
  expect(await core.listGroupMembers(spaceId, groupId)).toHaveLength(0);
});

test("removePrincipalFromSpace rejects a group (a group leaves only by deletion)", async () => {
  const groupId = await core.createGroup(spaceId, `rm_${rand(6)}`);

  let err: unknown;
  try {
    await core.removePrincipalFromSpace(spaceId, groupId);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(String(err)).toContain("delete the group instead");

  // the group is still rostered (not orphaned)
  expect(
    (await core.listSpaceGroups(spaceId)).some((g) => g.id === groupId),
  ).toBe(true);
  // deleting the group is the supported path; it cascades the roster row away
  expect(await core.deletePrincipal(groupId)).toBe(true);
  expect(
    (await core.listSpaceGroups(spaceId)).some((g) => g.id === groupId),
  ).toBe(false);
});

test("admin groups: create as admin, toggle via setGroupIsSpaceAdmin, confer admin to direct members", async () => {
  // create the group directly as an admin group
  const groupId = await core.createGroup(spaceId, `adm_${rand(6)}`, true);
  expect(
    (await core.listSpaceGroups(spaceId)).find((g) => g.id === groupId)
      ?.isSpaceAdmin,
  ).toBe(true);
  expect(
    (await core.listSpacePrincipals(spaceId, "g")).find((g) => g.id === groupId)
      ?.admin,
  ).toBe(true);

  // a direct member of the admin group gains effective space-admin
  const member = await v7();
  await core.createUser(member, `m_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(spaceId, member); // direct, non-admin
  await core.addGroupMember(spaceId, groupId, member);
  expect(await core.isSpaceAdmin(member, spaceId)).toBe(true);

  // demote the group (the beforeEach user is still a direct admin, so this is
  // allowed) → the member loses admin-via-group
  expect(await core.setGroupIsSpaceAdmin(spaceId, groupId, false)).toBe(true);
  expect(
    (await core.listSpaceGroups(spaceId)).find((g) => g.id === groupId)
      ?.isSpaceAdmin,
  ).toBe(false);
  expect(await core.isSpaceAdmin(member, spaceId)).toBe(false);

  // re-promote
  expect(await core.setGroupIsSpaceAdmin(spaceId, groupId, true)).toBe(true);
  expect(await core.isSpaceAdmin(member, spaceId)).toBe(true);
});

test("setGroupIsSpaceAdmin rejects a non-group principal", async () => {
  let err: unknown;
  try {
    await core.setGroupIsSpaceAdmin(spaceId, userId, true);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(String(err)).toContain("not a group");
});

test("demoting the sole admin group is rejected (ME001)", async () => {
  const sid = await core.createSpace(rand(12), "Group-admin Space");
  const groupId = await core.createGroup(sid, `admins_${rand(6)}`, true);
  const member = await v7();
  await core.createUser(member, `gm_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, member); // direct member (non-admin)
  await core.addGroupMember(sid, groupId, member); // sole effective admin via the group

  // demoting the only admin group would drop the space to zero effective admins
  await expectLastAdmin(core.setGroupIsSpaceAdmin(sid, groupId, false));
  // rolled back — still an admin group
  expect(
    (await core.listSpaceGroups(sid)).find((g) => g.id === groupId)
      ?.isSpaceAdmin,
  ).toBe(true);
});

test("space admin transfers through an admin group (only for direct members)", async () => {
  const groupId = await core.createGroup(spaceId, `admins_${rand(6)}`);
  // designate the group itself as an admin member of the space
  await core.addPrincipalToSpace(spaceId, groupId, true);

  // a user who is ONLY in the admin group (no direct membership) is NOT an
  // admin and is not a space member — group membership alone confers nothing
  const groupOnly = await v7();
  await core.createUser(groupOnly, `go_${rand(8)}@example.com`);
  await core.addGroupMember(spaceId, groupId, groupOnly);
  expect(await core.isSpaceAdmin(groupOnly, spaceId)).toBe(false);

  // once the user is also a direct member, admin transfers through the group
  const member = await v7();
  await core.createUser(member, `m_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(spaceId, member); // direct, non-admin
  await core.addGroupMember(spaceId, groupId, member);
  expect(await core.isSpaceAdmin(member, spaceId)).toBe(true);

  // listSpacePrincipals reports the same effective admin status (admin=true)
  // for the direct member, and omits the group-only user entirely
  const listed = await core.listSpacePrincipals(spaceId, "u");
  expect(listed.find((p) => p.id === member)?.admin).toBe(true);
  expect(listed.map((p) => p.id)).not.toContain(groupOnly);

  // a non-member is not an admin
  const stranger = await v7();
  await core.createUser(stranger, `s_${rand(8)}@example.com`);
  expect(await core.isSpaceAdmin(stranger, spaceId)).toBe(false);
});

test("group grants apply only to direct space members (no transitive membership)", async () => {
  const groupId = await core.createGroup(spaceId, `grp_${rand(6)}`);
  await core.grantTreeAccess(spaceId, groupId, "shared", ACCESS.write);

  // a user who is ONLY a group member (no principal_space row) gets nothing —
  // group membership alone does not confer space access, so build_tree_access
  // is empty (and the server auth gate would deny it).
  const groupOnly = await v7();
  await core.createUser(groupOnly, `go_${rand(8)}@example.com`);
  await core.addGroupMember(spaceId, groupId, groupOnly);
  expect(await core.buildTreeAccess(groupOnly, spaceId)).toEqual([]);

  // once the user is also a direct space member, the group grant applies
  const member = await v7();
  await core.createUser(member, `gm_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(spaceId, member); // direct membership
  await core.addGroupMember(spaceId, groupId, member);
  const ta = await core.buildTreeAccess(member, spaceId);
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

test("space invitations: create / list / accept / decline via the store", async () => {
  // spaceId + the owner userId come from beforeEach; the owner is the inviter
  const email = `invitee_${rand(8)}@example.com`;
  const { id: inviteId, token } = await core.createSpaceInvitation(
    spaceId,
    email,
    {
      admin: true,
      shareAccess: ACCESS.write,
      invitedBy: userId,
    },
  );
  expect(inviteId).toBeTruthy();
  expect(token).toMatch(/^inv\./); // an email invite is also a shareable link

  const pending = await core.listSpaceInvitations(spaceId);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.email).toBe(email);
  expect(pending[0]?.kind).toBe("email");
  expect(pending[0]?.admin).toBe(true);
  expect(pending[0]?.shareAccess).toBe(ACCESS.write);
  expect(pending[0]?.invitedBy).toBe(userId);
  expect(pending[0]?.invitedByName).toBe(userName);

  // the invitee registers; the invite shows in their email-keyed list
  const inviteeId = await v7();
  await core.createUser(inviteeId, email);
  const forEmail = await core.listInvitationsForEmail(email);
  expect(forEmail).toHaveLength(1);
  expect(forEmail[0]?.invitationId).toBe(inviteId);
  expect(forEmail[0]?.spaceId).toBe(spaceId);
  expect(forEmail[0]?.slug).toBeTruthy();
  expect(forEmail[0]?.invitedByName).toBe(userName);

  // accepting a different email's id (mismatch) joins nothing
  expect(
    await core.acceptSpaceInvitation(inviteeId, "nobody@example.com", inviteId),
  ).toBeNull();

  // accept by id, gated on the matching email
  const joined = await core.acceptSpaceInvitation(inviteeId, email, inviteId);
  expect(joined?.spaceId).toBe(spaceId);
  expect(joined?.slug).toBeTruthy();
  expect(joined?.admin).toBe(true);
  expect(joined?.shareAccess).toBe(ACCESS.write);

  // effective access: owner@home (from joining) + write@share
  const ta = await core.buildTreeAccess(inviteeId, spaceId);
  expect(ta).toContainEqual({
    tree_path: `home.${inviteeId.replace(/-/g, "")}`,
    access: ACCESS.owner,
  });
  expect(ta).toContainEqual({ tree_path: "share", access: ACCESS.write });

  // accepted → no longer pending (admin list or email list); re-accept is a no-op
  expect(await core.listSpaceInvitations(spaceId)).toHaveLength(0);
  expect(await core.listInvitationsForEmail(email)).toHaveLength(0);
  expect(
    await core.acceptSpaceInvitation(inviteeId, email, inviteId),
  ).toBeNull();

  // a fresh invite is declinable by the invitee (gated on email), once
  const { id: second } = await core.createSpaceInvitation(spaceId, email, {
    admin: false,
    shareAccess: null,
    invitedBy: userId,
  });
  expect(await core.declineSpaceInvitation("other@example.com", second)).toBe(
    false,
  );
  expect(await core.declineSpaceInvitation(email, second)).toBe(true);
  expect(await core.declineSpaceInvitation(email, second)).toBe(false);

  // the admin can still revoke a pending invite by email
  await core.createSpaceInvitation(spaceId, email, {
    admin: false,
    shareAccess: null,
    invitedBy: userId,
  });
  expect(await core.revokeSpaceInvitation(spaceId, email)).toBe(true);
  expect(await core.revokeSpaceInvitation(spaceId, email)).toBe(false);
});

test("magic links: open link multi-use + max_uses; email link enforces email; revoke", async () => {
  // an open shareable link (no email), capped at 2 redemptions
  const { token } = await core.createSpaceInvitation(spaceId, null, {
    admin: false,
    shareAccess: ACCESS.read,
    invitedBy: userId,
    maxUses: 2,
  });

  const mkUser = async () => {
    const id = await v7();
    await core.createUser(id, `lnk_${rand(8)}@example.com`);
    return id;
  };
  const u1 = await mkUser();
  const u2 = await mkUser();
  const u3 = await mkUser();

  // multi-use: two different users join (email is not checked for an open link)
  expect((await core.redeemInvitation(token, u1, null))?.spaceId).toBe(spaceId);
  expect((await core.redeemInvitation(token, u2, null))?.spaceId).toBe(spaceId);
  // joined with read@share
  expect(await core.buildTreeAccess(u1, spaceId)).toContainEqual({
    tree_path: "share",
    access: ACCESS.read,
  });
  // third redeemer exceeds max_uses
  expect(await core.redeemInvitation(token, u3, null)).toBeNull();

  // listed as a link with uses=2
  const link = (await core.listSpaceInvitations(spaceId)).find(
    (i) => i.kind === "link",
  );
  expect(link?.maxUses).toBe(2);
  expect(link?.uses).toBe(2);
  expect(link?.valid).toBe(false); // exhausted → still listed, marked invalid

  // a malformed token redeems nothing
  expect(await core.redeemInvitation("not-a-token", u3, null)).toBeNull();

  // an email-constrained link: only the matching email may redeem (single-use)
  const target = `target_${rand(8)}@example.com`;
  const { token: etoken } = await core.createSpaceInvitation(spaceId, target, {
    admin: false,
    shareAccess: null,
    invitedBy: userId,
  });
  const eUser = await v7();
  await core.createUser(eUser, target);
  expect(
    await core.redeemInvitation(etoken, eUser, "wrong@example.com"),
  ).toBeNull();
  expect((await core.redeemInvitation(etoken, eUser, target))?.spaceId).toBe(
    spaceId,
  );
  // single-use: a second redeem is rejected (consumed)
  expect(await core.redeemInvitation(etoken, eUser, target)).toBeNull();

  // revoke by id: a fresh link can't be redeemed afterward
  const { id: linkId, token: rtoken } = await core.createSpaceInvitation(
    spaceId,
    null,
    { admin: false, shareAccess: null, invitedBy: userId },
  );
  expect(await core.revokeInvitationById(spaceId, linkId)).toBe(true);
  const rUser = await mkUser();
  expect(await core.redeemInvitation(rtoken, rUser, null)).toBeNull();
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
  // a fresh space whose sole effective admin is a direct member who belongs to
  // an admin group (admin via a group requires direct membership)
  const sid = await core.createSpace(rand(12), "Group-admin Space");
  const groupId = await core.createGroup(sid, `admins_${rand(6)}`);
  await core.addPrincipalToSpace(sid, groupId, true);
  const member = await v7();
  await core.createUser(member, `gm_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, member); // direct member (non-admin)
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
  await core.addPrincipalToSpace(sid, member); // direct member (non-admin)
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

test("removing a via-group admin's direct membership is rejected (ME001)", async () => {
  // new-model case: the sole effective admin is a direct member who belongs to
  // an admin group. Removing their *direct* membership (which also scrubs their
  // group_member rows) drops the last effective admin — caught at commit.
  const sid = await core.createSpace(rand(12), "Group-admin Space");
  const groupId = await core.createGroup(sid, `admins_${rand(6)}`);
  await core.addPrincipalToSpace(sid, groupId, true); // group holds space-admin
  const member = await v7();
  await core.createUser(member, `gm_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, member); // direct member (non-admin)
  await core.addGroupMember(sid, groupId, member); // sole effective admin
  expect(await core.isSpaceAdmin(member, sid)).toBe(true);

  await expectLastAdmin(core.removePrincipalFromSpace(sid, member));
  // rolled back — still an effective admin
  expect(await core.isSpaceAdmin(member, sid)).toBe(true);
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

test("deleting a space with an admin group + members + grants cascades cleanly (teardown)", async () => {
  // Exercises the multi-path FK cascade on group_member (it is a cascade target
  // of space, of the group principal via the composite (group_id, space_id) FK,
  // and of the member principal) plus the enforce_last_admin teardown exemption
  // firing through both the group_member and admin principal_space deletes.
  const slug = rand(12);
  const sid = await core.createSpace(slug, "Doomed Group Space");

  const admin = await v7();
  await core.createUser(admin, `adm_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, admin, true); // direct admin

  const groupId = await core.createGroup(sid, `admins_${rand(6)}`, true); // admin group
  const member = await v7();
  await core.createUser(member, `mem_${rand(8)}@example.com`);
  await core.addPrincipalToSpace(sid, member); // direct member
  await core.addGroupMember(sid, groupId, member); // effective admin via the group

  await core.grantTreeAccess(sid, groupId, "shared", ACCESS.read);
  await core.grantTreeAccess(sid, member, "notes", ACCESS.write);

  // teardown must not trip the last-admin guard, and must cascade everything
  expect(await core.deleteSpace(slug)).toBe(true);
  expect(await core.getSpace(slug)).toBeNull();

  const countBySpace = async (table: string) => {
    const [r] = await sql.unsafe(
      `select count(*)::int as n from ${coreSchema}.${table} where space_id = $1`,
      [sid],
    );
    return Number(r?.n);
  };
  // every space-scoped row for the space is gone
  expect(await countBySpace("principal_space")).toBe(0);
  expect(await countBySpace("group_member")).toBe(0);
  expect(await countBySpace("tree_access")).toBe(0);

  // the group principal (space-scoped) is deleted; the users (global) survive
  expect(await core.getPrincipal(groupId)).toBeNull();
  expect((await core.getPrincipal(admin))?.id).toBe(admin);
  expect((await core.getPrincipal(member))?.id).toBe(member);
});
