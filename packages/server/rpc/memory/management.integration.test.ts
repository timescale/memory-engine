// Integration test for the space management handlers (4C-2b): member / agent /
// group / grant / invite, driven through the merged memory registry against a
// provisioned space. The provisioned owner has owner@root, satisfying the
// management authorization gate. (Api keys are user-endpoint — see
// rpc/user/api-key.integration.test.ts.)
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/memory/management.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  bootstrapSpaceDatabase,
  homePrefix,
  migrateCore,
} from "@memory.build/database";
import type { TreeAccess } from "@memory.build/engine/core";
import * as engineCore from "@memory.build/engine/core";
import * as engineSpace from "@memory.build/engine/space";
import { type AppErrorCode, isAppError } from "@memory.build/protocol/errors";
import postgres, { type Sql } from "postgres";
import { seedUserSpace } from "../../test-support";
import type { HandlerContext } from "../types";
import { memoryMethods } from "./index";

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
const createdSpaceSchemas: string[] = [];

let ownerTreeAccess: TreeAccess;
let space: { id: string; slug: string };
let ownerId: string;
let ownerEmail: string;

function call<T = unknown>(
  method: string,
  params: unknown,
  as: {
    principalId?: string;
    principalKind?: "u" | "a" | "s";
    treeAccess?: TreeAccess;
    admin?: boolean;
  } = {},
): Promise<T> {
  const registered = memoryMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const context = {
    request: new Request("http://localhost/api/v1/memory/rpc"),
    store: engineSpace.spaceStore(sql, `me_${space.slug}`),
    core: engineCore.coreStore(sql, coreSchema),
    space,
    principalId: as.principalId ?? ownerId,
    principalKind: as.principalKind ?? "u",
    ownerId: null, // user/session caller
    apiKeyId: null,
    treeAccess: as.treeAccess ?? ownerTreeAccess,
    // the provisioned owner is also a space admin; non-owner callers default false
    admin: as.admin ?? as.principalId === undefined,
  } as unknown as HandlerContext;
  return registered.handler(params, context) as Promise<T>;
}

async function expectAppError(p: Promise<unknown>, code: AppErrorCode) {
  try {
    await p;
    throw new Error(`expected AppError(${code}), but it resolved`);
  } catch (e) {
    if (!isAppError(e)) throw e;
    expect(e.code).toBe(code);
  }
}

/** Create a standalone global user (no auth), returning its id. */
async function makeUser(): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  const id = row?.id as string;
  await engineCore
    .coreStore(sql, coreSchema)
    .createUser(id, `u_${rand(8)}@example.com`);
  return id;
}

/**
 * Create a global agent owned by `owner` (the user-endpoint operation), returning
 * its id. Not yet a member of any space — principal.add brings it in.
 */
function makeAgent(owner: string): Promise<string> {
  return engineCore
    .coreStore(sql, coreSchema)
    .createAgent(owner, `agent_${rand(6)}`);
}

/** Create a registered user with a known email (the invite key), returning its id. */
async function makeUserWithEmail(email: string): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  const id = row?.id as string;
  await engineCore.coreStore(sql, coreSchema).createUser(id, email);
  return id;
}

/** The seeded space's default "team" group id (invites require an explicit group). */
async function teamGroupId(): Promise<string> {
  const groups = await engineCore
    .coreStore(sql, coreSchema)
    .listSpaceGroups(space.id);
  const team = groups.find((g) => g.name === "team");
  if (!team) throw new Error("seeded space has no team group");
  return team.id;
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand(8)}`;
  await bootstrapSpaceDatabase(sql);
  await migrateCore(sql, { schema: coreSchema });
});

afterAll(async () => {
  for (const s of createdSpaceSchemas) {
    await sql.unsafe(`drop schema if exists ${s} cascade`);
  }
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

beforeEach(async () => {
  ownerEmail = `owner_${crypto.randomUUID().slice(0, 8)}@example.com`;
  const r = await seedUserSpace(
    sql,
    { core: coreSchema },
    { email: ownerEmail, name: "Owner" },
  );
  createdSpaceSchemas.push(`me_${r.spaceSlug}`);
  space = { id: r.spaceId, slug: r.spaceSlug };
  ownerId = r.userId;
  ownerTreeAccess = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(r.userId, r.spaceId);
});

test("principal: list / add / remove", async () => {
  const listed = await call<{ principals: { id: string; admin: boolean }[] }>(
    "principal.list",
    {},
  );
  expect(listed.principals.some((m) => m.id === ownerId && m.admin)).toBe(true);

  const other = await makeUser();
  expect(
    (await call<{ added: boolean }>("principal.add", { principalId: other }))
      .added,
  ).toBe(true);
  expect(
    (
      await call<{ principals: { id: string }[] }>("principal.list", {})
    ).principals.some((m) => m.id === other),
  ).toBe(true);
  expect(
    (
      await call<{ removed: boolean }>("principal.remove", {
        principalId: other,
      })
    ).removed,
  ).toBe(true);
});

test("last-admin safeguard: removing/demoting the sole admin → LAST_ADMIN", async () => {
  // the provisioned owner is the space's only admin
  await expectAppError(
    call("principal.remove", { principalId: ownerId }),
    "LAST_ADMIN",
  );
  await expectAppError(
    call("principal.add", { principalId: ownerId, admin: false }),
    "LAST_ADMIN",
  );

  // promote a second admin, then the owner can be removed
  const other = await makeUser();
  await call("principal.add", { principalId: other, admin: true });
  expect(
    (
      await call<{ removed: boolean }>("principal.remove", {
        principalId: ownerId,
      })
    ).removed,
  ).toBe(true);
});

test("non-admin user can self-remove (leave), cascading their in-space agent", async () => {
  // a non-admin member with an agent they brought into the space
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  const agent = await makeAgent(member);
  const asMember = {
    principalId: member,
    admin: false,
    treeAccess: [{ tree_path: "share", access: 1 }] as TreeAccess,
  };
  await call("principal.add", { principalId: agent }, asMember); // self-service add

  // the member removes THEMSELVES (no admin) — succeeds
  expect(
    (
      await call<{ removed: boolean }>(
        "principal.remove",
        { principalId: member },
        asMember,
      )
    ).removed,
  ).toBe(true);

  // both the member and their agent are gone from the roster (DB cascade)
  const { principals } = await call<{ principals: { id: string }[] }>(
    "principal.list",
    {},
  );
  expect(principals.some((p) => p.id === member)).toBe(false);
  expect(principals.some((p) => p.id === agent)).toBe(false);
});

test("non-admin can remove their OWN agent, but not another user / another's agent", async () => {
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  const asMember = {
    principalId: member,
    admin: false,
    treeAccess: [{ tree_path: "share", access: 1 }] as TreeAccess,
  };

  // own agent → allowed
  const ownAgent = await makeAgent(member);
  await call("principal.add", { principalId: ownAgent }, asMember);
  expect(
    (
      await call<{ removed: boolean }>(
        "principal.remove",
        { principalId: ownAgent },
        asMember,
      )
    ).removed,
  ).toBe(true);

  // another user (the admin owner) → FORBIDDEN (authz before last-admin)
  await expectAppError(
    call("principal.remove", { principalId: ownerId }, asMember),
    "FORBIDDEN",
  );

  // someone else's agent → FORBIDDEN
  const otherUser = await makeUser();
  const otherAgent = await makeAgent(otherUser);
  await call("principal.add", { principalId: otherAgent });
  await expectAppError(
    call("principal.remove", { principalId: otherAgent }, asMember),
    "FORBIDDEN",
  );
});

test("principal.resolve / lookup are available to non-admin members (list is admin-only)", async () => {
  const email = `target_${rand(8)}@example.com`;
  const targetId = await makeUserWithEmail(email);
  await call("principal.add", { principalId: targetId }); // added by the admin owner

  // a non-admin caller: resolve/lookup have no authority gate beyond being in the
  // space, so they work; principal.list (full enumeration) does not.
  const asMember = {
    principalId: targetId,
    treeAccess: [{ tree_path: "x", access: 1 }] as TreeAccess,
    admin: false,
  };

  const resolved = await call<{ principals: { id: string; name: string }[] }>(
    "principal.resolve",
    { name: email.toUpperCase() }, // case-insensitive
    asMember,
  );
  expect(resolved.principals).toHaveLength(1);
  expect(resolved.principals[0]?.id).toBe(targetId);

  const looked = await call<{ principals: { id: string; name: string }[] }>(
    "principal.lookup",
    { ids: [targetId] },
    asMember,
  );
  expect(looked.principals[0]?.name).toBe(email);

  // a name that isn't in the space resolves to nothing
  expect(
    (
      await call<{ principals: unknown[] }>(
        "principal.resolve",
        { name: `nobody_${rand(8)}@example.com` },
        asMember,
      )
    ).principals,
  ).toHaveLength(0);

  // full enumeration stays admin-only
  await expectAppError(call("principal.list", {}, asMember), "FORBIDDEN");
});

test("group: create / list / members / rename / delete", async () => {
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: "eng",
  });
  expect(
    (await call<{ groups: { id: string }[] }>("group.list", {})).groups.some(
      (g) => g.id === groupId,
    ),
  ).toBe(true);

  // The group is rostered into principal_space on creation, so it appears in
  // the space roster (principal.list) as a kind 'g' principal and resolves by
  // name — this is what lets `me access grant <group-name>` work (TNT-160).
  const roster = await call<{ principals: { id: string; kind: string }[] }>(
    "principal.list",
    { kind: "g" },
  );
  expect(
    roster.principals.some((p) => p.id === groupId && p.kind === "g"),
  ).toBe(true);
  const resolved = await call<{ principals: { id: string }[] }>(
    "principal.resolve",
    { name: "eng" },
  );
  expect(resolved.principals.some((p) => p.id === groupId)).toBe(true);

  await call("group.addMember", { groupId, memberId: ownerId, admin: true });
  const members = await call<{
    members: { memberId: string; admin: boolean }[];
  }>("group.listMembers", { groupId });
  expect(members.members[0]?.memberId).toBe(ownerId);
  expect(members.members[0]?.admin).toBe(true);

  const forMember = await call<{ groups: { groupId: string }[] }>(
    "group.listForMember",
    { memberId: ownerId },
  );
  expect(forMember.groups.some((g) => g.groupId === groupId)).toBe(true);

  expect(
    (
      await call<{ renamed: boolean }>("group.rename", {
        id: groupId,
        name: "platform",
      })
    ).renamed,
  ).toBe(true);
  expect(
    (
      await call<{ removed: boolean }>("group.removeMember", {
        groupId,
        memberId: ownerId,
      })
    ).removed,
  ).toBe(true);
  expect(
    (await call<{ deleted: boolean }>("group.delete", { id: groupId })).deleted,
  ).toBe(true);
});

test("admin groups: group.create --space-admin and group.setIsSpaceAdmin toggle", async () => {
  // create as an admin group
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: "leads",
    isSpaceAdmin: true,
  });
  const listed = await call<{
    groups: { id: string; isSpaceAdmin: boolean }[];
  }>("group.list", {});
  expect(listed.groups.find((g) => g.id === groupId)?.isSpaceAdmin).toBe(true);

  // demote, then re-promote
  const demoted = await call<{ isSpaceAdmin: boolean; updated: boolean }>(
    "group.setIsSpaceAdmin",
    { id: groupId, isSpaceAdmin: false },
  );
  expect(demoted).toEqual({ isSpaceAdmin: false, updated: true });
  expect(
    (
      await call<{ groups: { id: string; isSpaceAdmin: boolean }[] }>(
        "group.list",
        {},
      )
    ).groups.find((g) => g.id === groupId)?.isSpaceAdmin,
  ).toBe(false);

  const promoted = await call<{ isSpaceAdmin: boolean; updated: boolean }>(
    "group.setIsSpaceAdmin",
    { id: groupId, isSpaceAdmin: true },
  );
  expect(promoted).toEqual({ isSpaceAdmin: true, updated: true });
});

test("grant: set / list / remove", async () => {
  const other = await makeUser();
  await call("grant.set", { principalId: other, treePath: "docs", access: 1 });
  const grants = await call<{
    grants: { principalId: string; treePath: string; access: number }[];
  }>("grant.list", { principalId: other });
  expect(grants.grants).toHaveLength(1);
  expect(grants.grants[0]?.treePath).toBe("/docs");
  expect(grants.grants[0]?.access).toBe(1);

  expect(
    (
      await call<{ removed: boolean }>("grant.remove", {
        principalId: other,
        treePath: "docs",
      })
    ).removed,
  ).toBe(true);
});

test("invite.create: records a pending invite; list + revoke", async () => {
  const email = `newcomer_${rand(8)}@example.com`;
  const res = await call<{ invitationId: string }>("invite.create", {
    email,
    admin: false,
    groupIds: [await teamGroupId()],
  });
  expect(res.invitationId).toBeTruthy();

  const { invitations } = await call<{
    invitations: {
      email: string;
      groupNames: string[];
      invitedByName: string | null;
    }[];
  }>("invite.list", {});
  expect(invitations).toHaveLength(1);
  expect(invitations[0]?.email).toBe(email);
  expect(invitations[0]?.groupNames).toEqual(["team"]);
  expect(invitations[0]?.invitedByName).toBe(ownerEmail); // the owner invited

  expect(
    (await call<{ revoked: boolean }>("invite.revoke", { email })).revoked,
  ).toBe(true);
  expect(
    (await call<{ invitations: unknown[] }>("invite.list", {})).invitations,
  ).toHaveLength(0);
});

test("invite.create: targets a named group; rejects a group not in the space", async () => {
  // a custom group in this space
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: `crew_${rand(6)}`,
  });
  const email = `custom_${rand(8)}@example.com`;
  await call("invite.create", { email, groupIds: [groupId] });
  const { invitations } = await call<{
    invitations: { email: string; groupIds: string[] }[];
  }>("invite.list", {});
  expect(invitations.find((i) => i.email === email)?.groupIds).toEqual([
    groupId,
  ]);

  // a group id that isn't a group in this space → NOT_FOUND
  const bogus = (await sql`select uuidv7() as id`)[0]?.id as string;
  await expectAppError(
    call("invite.create", {
      email: `nope_${rand(8)}@example.com`,
      groupIds: [bogus],
    }),
    "NOT_FOUND",
  );
});

test("invite.create: an already-registered user also gets a PENDING invite (no auto-enroll)", async () => {
  const email = `existing_${rand(8)}@example.com`;
  const existingId = await makeUserWithEmail(email);

  const res = await call<{ invitationId: string }>("invite.create", {
    email,
    admin: true,
    groupIds: [await teamGroupId()],
  });
  expect(res.invitationId).toBeTruthy();

  // NOT added to the space — acceptance is explicit, even for an existing user.
  const core = engineCore.coreStore(sql, coreSchema);
  const principals = await core.listSpacePrincipals(space.id);
  expect(principals.find((p) => p.id === existingId)).toBeUndefined();

  // shown as a pending invitation instead
  const { invitations } = await call<{ invitations: { email: string }[] }>(
    "invite.list",
    {},
  );
  expect(invitations.some((i) => i.email === email)).toBe(true);
});

test("invite.create (open link): returns a token, lists as a link, revokeById", async () => {
  const res = await call<{ invitationId: string; token: string }>(
    "invite.create",
    { admin: false, maxUses: 5, groupIds: [await teamGroupId()] },
  );
  expect(res.invitationId).toBeTruthy();
  expect(res.token).toMatch(/^inv\./);

  const { invitations } = await call<{
    invitations: {
      id: string;
      kind: string;
      email: string | null;
      maxUses: number | null;
      uses: number;
      valid: boolean;
      token: string | null;
    }[];
  }>("invite.list", {});
  const link = invitations.find((i) => i.id === res.invitationId);
  expect(link?.kind).toBe("link");
  expect(link?.email).toBeNull();
  expect(link?.maxUses).toBe(5);
  expect(link?.uses).toBe(0);
  expect(link?.valid).toBe(true); // fresh, unused → still valid
  expect(link?.token).toBe(res.token); // admin can re-copy the URL from the list

  expect(
    (
      await call<{ revoked: boolean }>("invite.revokeById", {
        invitationId: res.invitationId,
      })
    ).revoked,
  ).toBe(true);
  // gone from the list after revoke
  expect(
    (
      await call<{ invitations: { id: string }[] }>("invite.list", {})
    ).invitations.some((i) => i.id === res.invitationId),
  ).toBe(false);
});

test("invite.* require space-admin authority (owner@root is not enough)", async () => {
  // a plain member with no authority
  const plain = await makeUser();
  const asPlain = {
    principalId: plain,
    treeAccess: [] as TreeAccess,
    admin: false,
  };
  await expectAppError(call("invite.list", {}, asPlain), "FORBIDDEN");

  // a member who owns the whole data tree (owner@root) but is NOT a space admin
  // is still forbidden — inviting is structural, like group management
  const rootOwner = await makeUser();
  await call("principal.add", { principalId: rootOwner });
  await call("grant.set", { principalId: rootOwner, treePath: "", access: 3 });
  const ta = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(rootOwner, space.id);
  const asOwner = { principalId: rootOwner, treeAccess: ta, admin: false };
  await expectAppError(
    call(
      "invite.create",
      // a valid (in-space) group, so this exercises the authorization gate, not
      // param validation — a non-admin is FORBIDDEN even with a well-formed invite
      {
        email: `x_${rand(8)}@example.com`,
        admin: false,
        groupIds: [await teamGroupId()],
      },
      asOwner,
    ),
    "FORBIDDEN",
  );
  await expectAppError(call("invite.list", {}, asOwner), "FORBIDDEN");
  await expectAppError(
    call("invite.revoke", { email: `x_${rand(8)}@example.com` }, asOwner),
    "FORBIDDEN",
  );
});

test("roster/group management requires admin or owner", async () => {
  // a plain member: write access on a subtree, not an admin, not a root owner
  const member = await makeUser();
  const as = {
    principalId: member,
    treeAccess: [{ tree_path: "sub", access: 2 }] as TreeAccess,
    admin: false,
  };
  await expectAppError(call("principal.list", {}, as), "FORBIDDEN");
  await expectAppError(call("group.create", { name: "x" }, as), "FORBIDDEN");
});

test("a space admin (without owner@root) has management authority", async () => {
  // an admin member with read on a path (plus its own home from joining), but no
  // owner@root — so the management authority here comes from admin, not ownership
  const adminMember = await makeUser();
  await call("principal.add", { principalId: adminMember, admin: true });
  await call("grant.set", {
    principalId: adminMember,
    treePath: "x",
    access: 1,
  });
  const ta = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(adminMember, space.id);
  const as = { principalId: adminMember, treeAccess: ta, admin: true };

  // can manage the roster and grant anywhere despite holding no owner grant
  expect(
    (await call<{ principals: unknown[] }>("principal.list", {}, as)).principals
      .length,
  ).toBeGreaterThan(0);
  const stranger = await makeUser();
  expect(
    (
      await call<{ granted: boolean }>(
        "grant.set",
        { principalId: stranger, treePath: "anywhere", access: 2 },
        as,
      )
    ).granted,
  ).toBe(true);
});

test("group.listForMember: own memberships are self-service, others need admin", async () => {
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: "squad",
  });
  const member = await makeUser();
  await call("group.addMember", { groupId, memberId: member });
  const as = {
    principalId: member,
    treeAccess: [] as TreeAccess,
    admin: false,
  };

  // the member can see their own memberships
  const mine = await call<{ groups: { groupId: string }[] }>(
    "group.listForMember",
    { memberId: member },
    as,
  );
  expect(mine.groups.some((g) => g.groupId === groupId)).toBe(true);

  // but not someone else's
  await expectAppError(
    call("group.listForMember", { memberId: ownerId }, as),
    "FORBIDDEN",
  );
});

test("grant.list: own grants are self-service, others/whole-space need admin", async () => {
  // a plain member: not a space admin, holds only a single read grant, owns no
  // tree path (treeAccess intentionally empty so ownsTreePath is false)
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  await call("grant.set", { principalId: member, treePath: "docs", access: 1 });
  const as = {
    principalId: member,
    treeAccess: [] as TreeAccess,
    admin: false,
  };

  // the member can list their OWN grants (powers `me access mine`)
  const mine = await call<{
    grants: { principalId: string; treePath: string }[];
  }>("grant.list", { principalId: member }, as);
  // every row is the caller's own, and the docs grant is present
  expect(mine.grants.length).toBeGreaterThan(0);
  expect(mine.grants.every((g) => g.principalId === member)).toBe(true);
  expect(mine.grants.some((g) => g.treePath === "/docs")).toBe(true);

  // but not someone else's grants, nor the whole space (no principal filter)
  const other = await makeUser();
  await expectAppError(
    call("grant.list", { principalId: other }, as),
    "FORBIDDEN",
  );
  await expectAppError(call("grant.list", {}, as), "FORBIDDEN");
});

test("access.effective: current caller sees effective group access", async () => {
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: `readers_${rand(6)}`,
  });
  await call("group.addMember", { groupId, memberId: member });
  await call("grant.set", {
    principalId: groupId,
    treePath: "docs",
    access: 1,
  });

  const core = engineCore.coreStore(sql, coreSchema);
  const memberAccess = await core.buildTreeAccess(member, space.id);
  const result = await call<{
    principal: { id: string; kind: string; admin: boolean };
    access: { treePath: string; accessName: string }[];
  }>(
    "access.effective",
    {},
    { principalId: member, treeAccess: memberAccess, admin: false },
  );

  expect(result.principal).toMatchObject({
    id: member,
    kind: "u",
    admin: false,
  });
  expect(result.access).toContainEqual(
    expect.objectContaining({ treePath: "/docs", accessName: "read" }),
  );
});

test("access.effective: admin can inspect another member's effective access", async () => {
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: `writers_${rand(6)}`,
  });
  await call("group.addMember", { groupId, memberId: member });
  await call("grant.set", {
    principalId: groupId,
    treePath: "projects",
    access: 2,
  });
  await call("grant.set", {
    principalId: groupId,
    treePath: `${homePrefix(ownerId)}.delegated`,
    access: 1,
  });

  const result = await call<{
    principal: { id: string };
    authenticatedAs: unknown;
    access: { treePath: string; accessName: string }[];
  }>("access.effective", { principalId: member });

  expect(result.principal.id).toBe(member);
  // authenticatedAs describes the caller's session, not the target — it is null
  // when inspecting another principal so the target's access is not paired with
  // the caller's identity.
  expect(result.authenticatedAs).toBeNull();
  expect(result.access).toContainEqual(
    expect.objectContaining({ treePath: "/projects", accessName: "write" }),
  );
  expect(result.access).toContainEqual(
    expect.objectContaining({
      treePath: `/${homePrefix(ownerId).replace(/\./g, "/")}/delegated`,
      accessName: "read",
    }),
  );
  expect(result.access).not.toContainEqual(
    expect.objectContaining({ treePath: "~/delegated" }),
  );
  // `~` is the caller's home only. When inspecting another principal, their own
  // home renders absolutely (never `~`), so a `~` is never misattributed.
  expect(result.access).toContainEqual(
    expect.objectContaining({
      treePath: `/${homePrefix(member).replace(/\./g, "/")}`,
    }),
  );
  expect(result.access.every((entry) => !entry.treePath.startsWith("~"))).toBe(
    true,
  );
});

test("access.effective: an agent owner can inspect clamped agent access", async () => {
  const member = await makeUser();
  const agentId = await makeAgent(member);
  await call("principal.add", { principalId: member });
  await call("principal.add", { principalId: agentId });
  await call("grant.set", { principalId: member, treePath: "docs", access: 1 });
  await call("grant.set", {
    principalId: agentId,
    treePath: "docs",
    access: 2,
  });

  const core = engineCore.coreStore(sql, coreSchema);
  const memberAccess = await core.buildTreeAccess(member, space.id);
  const result = await call<{
    principal: { id: string; kind: string };
    access: { treePath: string; accessName: string }[];
  }>(
    "access.effective",
    { principalId: agentId },
    { principalId: member, treeAccess: memberAccess, admin: false },
  );

  expect(result.principal).toMatchObject({ id: agentId, kind: "a" });
  expect(result.access).toContainEqual(
    expect.objectContaining({ treePath: "/docs", accessName: "read" }),
  );
});

test("access.effective: service-account admin can inspect service-account group access", async () => {
  const core = engineCore.coreStore(sql, coreSchema);
  const manager = await makeUser();
  await call("principal.add", { principalId: manager });
  const serviceAccount = await core.createServiceAccount(
    space.id,
    `sa_${rand(6)}`,
    { adminMembers: [{ memberId: manager }] },
  );
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: `robots_${rand(6)}`,
  });
  await call("group.addMember", { groupId, memberId: serviceAccount.id });
  await call("grant.set", {
    principalId: groupId,
    treePath: "z_robots",
    access: 2,
  });
  await call("grant.set", {
    principalId: groupId,
    treePath: "a_robots",
    access: 2,
  });

  const result = await call<{
    principal: { id: string; kind: string };
    access: { treePath: string; accessName: string }[];
  }>(
    "access.effective",
    { principalId: serviceAccount.id },
    { principalId: manager, treeAccess: [], admin: false },
  );

  expect(result.principal).toMatchObject({ id: serviceAccount.id, kind: "s" });
  expect(result.access).toContainEqual(
    expect.objectContaining({ treePath: "/a_robots", accessName: "write" }),
  );
  expect(result.access).toContainEqual(
    expect.objectContaining({ treePath: "/z_robots", accessName: "write" }),
  );
  expect(result.access.map((row) => row.treePath)).toEqual([
    "/a_robots",
    "/z_robots",
  ]);
});

test("access.effective: rejects unrelated principals and groups", async () => {
  const member = await makeUser();
  const other = await makeUser();
  await call("principal.add", { principalId: member });
  await call("principal.add", { principalId: other });
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: `group_${rand(6)}`,
  });

  await expectAppError(
    call(
      "access.effective",
      { principalId: other },
      { principalId: member, treeAccess: [], admin: false },
    ),
    "FORBIDDEN",
  );
  await expectAppError(
    call("access.effective", { principalId: groupId }),
    "VALIDATION_ERROR",
  );
});

test("grant.list: an agent's owner can list its grants", async () => {
  // a member who owns an agent that holds a grant; the member is not an admin
  // and owns no tree path of their own
  const member = await makeUser();
  const agentId = await makeAgent(member);
  await call("principal.add", { principalId: agentId });
  await call("grant.set", {
    principalId: agentId,
    treePath: "docs",
    access: 1,
  });
  const as = {
    principalId: member,
    treeAccess: [] as TreeAccess,
    admin: false,
  };

  const res = await call<{ grants: { principalId: string }[] }>(
    "grant.list",
    { principalId: agentId },
    as,
  );
  expect(res.grants.some((g) => g.principalId === agentId)).toBe(true);

  // a stranger who doesn't own the agent cannot
  const stranger = await makeUser();
  await expectAppError(
    call(
      "grant.list",
      { principalId: agentId },
      { principalId: stranger, treeAccess: [] as TreeAccess, admin: false },
    ),
    "FORBIDDEN",
  );
});

test("grant.list/remove: a service-account admin can inspect and revoke its grants", async () => {
  const core = engineCore.coreStore(sql, coreSchema);
  const manager = await makeUser();
  await call("principal.add", { principalId: manager });
  const serviceAccount = await core.createServiceAccount(
    space.id,
    `sa_${rand(6)}`,
    { adminMembers: [{ memberId: manager }] },
  );
  await call("grant.set", {
    principalId: serviceAccount.id,
    treePath: "robots",
    access: 2,
  });

  const asManager = {
    principalId: manager,
    treeAccess: [] as TreeAccess,
    admin: false,
  };
  const grants = await call<{
    grants: { principalId: string; treePath: string }[];
  }>("grant.list", { principalId: serviceAccount.id }, asManager);
  expect(grants.grants).toContainEqual(
    expect.objectContaining({
      principalId: serviceAccount.id,
      treePath: "/robots",
    }),
  );

  await expectAppError(
    call(
      "grant.set",
      { principalId: serviceAccount.id, treePath: "robots", access: 1 },
      asManager,
    ),
    "FORBIDDEN",
  );
  expect(
    (
      await call<{ removed: boolean }>(
        "grant.remove",
        { principalId: serviceAccount.id, treePath: "robots" },
        asManager,
      )
    ).removed,
  ).toBe(true);
});

test("service-account callers do not get '~' home expansion", async () => {
  const core = engineCore.coreStore(sql, coreSchema);
  const serviceAccount = await core.createServiceAccount(
    space.id,
    `sa_${rand(6)}`,
  );
  await call("grant.set", {
    principalId: serviceAccount.id,
    treePath: "robots",
    access: 2,
  });
  await expectAppError(
    call(
      "grant.set",
      { principalId: serviceAccount.id, treePath: "~", access: 1 },
      {
        principalId: serviceAccount.id,
        principalKind: "s",
        treeAccess: await core.buildTreeAccess(serviceAccount.id, space.id),
        admin: false,
      },
    ),
    "VALIDATION_ERROR",
  );
});

test("grant.set/remove: an agent's owner can grant at an unowned path (TNT-165)", async () => {
  // A member who is NOT a space admin and does NOT own the target subtree — they
  // hold only write@share.work (level 2, not owner) — can still grant and revoke
  // access for their OWN agent there. Agent access is clamped to the owner's, so
  // this self-service can't escalate beyond what the owner already has.
  const core = engineCore.coreStore(sql, coreSchema);
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  // real, non-owner write access for the member at share.work
  await call("grant.set", {
    principalId: member,
    treePath: "share/work",
    access: 2,
  });
  const agentId = await makeAgent(member);
  await call("principal.add", { principalId: agentId });

  const memberTa = await core.buildTreeAccess(member, space.id);
  const as = { principalId: member, treeAccess: memberTa, admin: false };

  // they can grant their own agent at share.work.sub despite holding no owner
  // grant there (the agent-ownership bypass, not admin/owner, is what allows it)
  expect(
    (
      await call<{ granted: boolean }>(
        "grant.set",
        { principalId: agentId, treePath: "share/work/sub", access: 2 },
        as,
      )
    ).granted,
  ).toBe(true);

  // proof it's the agent-ownership doing the work: granting the SAME path to a
  // plain user (a space member, but NOT the caller's agent) is forbidden for
  // this same member — so the failure is strictly the missing agent-ownership
  // authority, not the target's non-membership.
  const otherUser = await makeUser();
  await call("principal.add", { principalId: otherUser });
  await expectAppError(
    call(
      "grant.set",
      { principalId: otherUser, treePath: "share/work/sub", access: 2 },
      as,
    ),
    "FORBIDDEN",
  );

  // the grant is EFFECTIVE, clamped to the owner's write (min(2, 2) = 2)
  const agentTa = await core.buildTreeAccess(agentId, space.id);
  expect(agentTa).toContainEqual({ tree_path: "share.work.sub", access: 2 });

  // they can revoke it too
  expect(
    (
      await call<{ removed: boolean }>(
        "grant.remove",
        { principalId: agentId, treePath: "share/work/sub" },
        as,
      )
    ).removed,
  ).toBe(true);

  // a stranger who doesn't own the agent (and isn't admin/owner) cannot
  const stranger = await makeUser();
  const asStranger = {
    principalId: stranger,
    treeAccess: [] as TreeAccess,
    admin: false,
  };
  await expectAppError(
    call(
      "grant.set",
      { principalId: agentId, treePath: "share/work/sub", access: 2 },
      asStranger,
    ),
    "FORBIDDEN",
  );
  await expectAppError(
    call(
      "grant.remove",
      { principalId: agentId, treePath: "share/work/sub" },
      asStranger,
    ),
    "FORBIDDEN",
  );
});

test("an agent grant is clamped DOWN to the owner's level, not dropped (TNT-165)", async () => {
  // The headline case: a member holding only READ at share.work grants their
  // agent WRITE at share.work.sub. The grant is allowed (self-service) and the
  // agent ends up with READ there — clamped down to the owner's level, not
  // dropped to nothing.
  const core = engineCore.coreStore(sql, coreSchema);
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  await call("grant.set", {
    principalId: member,
    treePath: "share/work",
    access: 1,
  });
  const agentId = await makeAgent(member);
  await call("principal.add", { principalId: agentId });
  const as = {
    principalId: member,
    treeAccess: await core.buildTreeAccess(member, space.id),
    admin: false,
  };

  expect(
    (
      await call<{ granted: boolean }>(
        "grant.set",
        { principalId: agentId, treePath: "share/work/sub", access: 2 },
        as,
      )
    ).granted,
  ).toBe(true);

  // owner holds read(1) at share.work → the agent's write(2) clamps to read(1)
  const agentTa = await core.buildTreeAccess(agentId, space.id);
  expect(agentTa).toContainEqual({ tree_path: "share.work.sub", access: 1 });
});

test("group member management allows a group admin (not a space admin)", async () => {
  // owner creates a group and makes `lead` an admin of it (a fresh name — every
  // space is now provisioned with a default "team" group)
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: "squad",
  });
  const lead = await makeUser();
  // lead is only a group admin (not a space admin) — group-admin authority over
  // a group is independent of the space-admin flag, so it is enough to manage
  // the group's membership
  await call("group.addMember", { groupId, memberId: lead, admin: true });
  const as = { principalId: lead, treeAccess: [] as TreeAccess, admin: false };

  // lead can manage THIS group's membership
  const other = await makeUser();
  expect(
    (
      await call<{ added: boolean }>(
        "group.addMember",
        { groupId, memberId: other },
        as,
      )
    ).added,
  ).toBe(true);
  const members = await call<{ members: { memberId: string }[] }>(
    "group.listMembers",
    { groupId },
    as,
  );
  expect(members.members.some((m) => m.memberId === other)).toBe(true);
  expect(
    (
      await call<{ removed: boolean }>(
        "group.removeMember",
        { groupId, memberId: other },
        as,
      )
    ).removed,
  ).toBe(true);

  // but structural ops (create) still require a space admin
  await expectAppError(call("group.create", { name: "nope" }, as), "FORBIDDEN");

  // and a non-admin, non-member can't manage the group
  const stranger = await makeUser();
  await expectAppError(
    call(
      "group.listMembers",
      { groupId },
      { principalId: stranger, treeAccess: [] as TreeAccess, admin: false },
    ),
    "FORBIDDEN",
  );
});

test("group member management allows a service-account group admin with zero tree grants", async () => {
  const core = engineCore.coreStore(sql, coreSchema);
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: "robot-admins",
  });
  const serviceAccount = await core.createServiceAccount(
    space.id,
    `sa_${rand(6)}`,
  );
  await call("group.addMember", {
    groupId,
    memberId: serviceAccount.id,
    admin: true,
  });
  const serviceAccess = await core.buildTreeAccess(serviceAccount.id, space.id);
  expect(serviceAccess).toEqual([]);
  const asService = {
    principalId: serviceAccount.id,
    principalKind: "s" as const,
    treeAccess: serviceAccess,
    admin: false,
  };

  const member = await makeUser();
  expect(
    (
      await call<{ added: boolean }>(
        "group.addMember",
        { groupId, memberId: member },
        asService,
      )
    ).added,
  ).toBe(true);
  const members = await call<{ members: { memberId: string }[] }>(
    "group.listMembers",
    { groupId },
    asService,
  );
  expect(members.members.some((m) => m.memberId === member)).toBe(true);
  expect(
    (
      await call<{ removed: boolean }>(
        "group.removeMember",
        { groupId, memberId: member },
        asService,
      )
    ).removed,
  ).toBe(true);

  await expectAppError(
    call("group.create", { name: "service-created" }, asService),
    "FORBIDDEN",
  );
});

test("service-account admin group membership is managed only by space admins or user SA admins", async () => {
  const core = engineCore.coreStore(sql, coreSchema);
  const manager = await makeUser();
  await core.addPrincipalToSpace(space.id, manager);
  const target = await core.createServiceAccount(
    space.id,
    `target_${rand(6)}`,
    {
      adminMembers: [{ memberId: manager }],
    },
  );
  const robot = await core.createServiceAccount(space.id, `robot_${rand(6)}`);
  const member = await makeUser();

  await call("group.addMember", {
    groupId: target.adminId,
    memberId: robot.id,
    admin: true,
  });

  const asRobot = {
    principalId: robot.id,
    principalKind: "s" as const,
    treeAccess: await core.buildTreeAccess(robot.id, space.id),
    admin: false,
  };
  await expectAppError(
    call(
      "group.addMember",
      { groupId: target.adminId, memberId: member },
      asRobot,
    ),
    "FORBIDDEN",
  );
  await expectAppError(
    call("group.listMembers", { groupId: target.adminId }, asRobot),
    "FORBIDDEN",
  );

  const asManager = {
    principalId: manager,
    principalKind: "u" as const,
    treeAccess: [] as TreeAccess,
    admin: false,
  };
  expect(
    (
      await call<{ added: boolean }>(
        "group.addMember",
        { groupId: target.adminId, memberId: member },
        asManager,
      )
    ).added,
  ).toBe(true);
  const members = await call<{ members: { memberId: string }[] }>(
    "group.listMembers",
    { groupId: target.adminId },
    asManager,
  );
  expect(members.members.some((m) => m.memberId === member)).toBe(true);
  expect(
    (
      await call<{ removed: boolean }>(
        "group.removeMember",
        { groupId: target.adminId, memberId: member },
        asManager,
      )
    ).removed,
  ).toBe(true);
});

test("group.listForMember: an agent's owner can list its groups", async () => {
  // owner sets up: a member who owns an agent, the agent is in a group
  const member = await makeUser();
  const agentId = await makeAgent(member);
  await call("principal.add", { principalId: agentId });
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: "bots",
  });
  await call("group.addMember", { groupId, memberId: agentId });

  // the member (agent owner, not a space admin) can list their agent's groups
  const as = {
    principalId: member,
    treeAccess: [] as TreeAccess,
    admin: false,
  };
  const res = await call<{ groups: { groupId: string }[] }>(
    "group.listForMember",
    { memberId: agentId },
    as,
  );
  expect(res.groups.some((g) => g.groupId === groupId)).toBe(true);

  // a stranger who doesn't own the agent cannot
  const stranger = await makeUser();
  await expectAppError(
    call(
      "group.listForMember",
      { memberId: agentId },
      { principalId: stranger, treeAccess: [] as TreeAccess, admin: false },
    ),
    "FORBIDDEN",
  );
});

test("structural mutations require admin — owner@root is not enough", async () => {
  // a member who owns the whole data tree (owner@root) but is NOT a space admin
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  await call("grant.set", { principalId: member, treePath: "", access: 3 });
  const ta = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(member, space.id);
  const as = { principalId: member, treeAccess: ta, admin: false };

  // owner@root can manage grants on its data — e.g. list them...
  expect(
    (await call<{ grants: unknown[] }>("grant.list", {}, as)).grants.length,
  ).toBeGreaterThan(0);
  // ...but the roster (enumeration + add/remove) and groups are admin-only:
  // owning the data tree is not structural authority.
  await expectAppError(call("principal.list", {}, as), "FORBIDDEN");
  const stranger = await makeUser();
  await expectAppError(
    call("principal.add", { principalId: stranger }, as),
    "FORBIDDEN",
  );
  // Removing ANOTHER principal is admin-only (the self / own-agent carve-outs
  // are exercised in the dedicated self-remove test above).
  await expectAppError(
    call("principal.remove", { principalId: stranger }, as),
    "FORBIDDEN",
  );
  await expectAppError(call("group.create", { name: "g" }, as), "FORBIDDEN");
});

test("grant authority is path-scoped: a subtree owner delegates within it", async () => {
  // a member who owns "proj" (not the root) can manage access under proj only
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  await call("grant.set", { principalId: member, treePath: "proj", access: 3 });
  const memberTA = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(member, space.id);
  const as = { principalId: member, treeAccess: memberTA };

  const stranger = await makeUser();
  // within the owned subtree → allowed
  expect(
    (
      await call<{ granted: boolean }>(
        "grant.set",
        { principalId: stranger, treePath: "proj.sub", access: 1 },
        as,
      )
    ).granted,
  ).toBe(true);
  // outside it → FORBIDDEN
  await expectAppError(
    call(
      "grant.set",
      { principalId: stranger, treePath: "other", access: 1 },
      as,
    ),
    "FORBIDDEN",
  );

  // can list grants under the owned subtree, but not the whole space
  const underProj = await call<{
    grants: { treePath: string }[];
  }>("grant.list", { treePath: "proj" }, as);
  expect(underProj.grants.some((g) => g.treePath === "/proj/sub")).toBe(true);
  await expectAppError(call("grant.list", {}, as), "FORBIDDEN");
});

test("self-service: a non-owner member brings their own agent into the space", async () => {
  // owner onboards a second user with write (not owner) on a subtree
  const member = await makeUser();
  await call("principal.add", { principalId: member });
  await call("grant.set", { principalId: member, treePath: "proj", access: 2 });
  const memberTA = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(member, space.id);
  const as = { principalId: member, treeAccess: memberTA };

  // the member created their agent on the user endpoint (simulated via core);
  // they bring it into the space (self-service principal.add) without owner rights
  const agentId = await makeAgent(member);
  expect(
    (
      await call<{ added: boolean }>(
        "principal.add",
        { principalId: agentId },
        as,
      )
    ).added,
  ).toBe(true);

  // and self-grant it (capped by their own access). Minting the agent's api key
  // is a user-endpoint op (apiKey.* — see rpc/user/api-key.integration.test.ts).
  expect(
    (
      await call<{ granted: boolean }>(
        "grant.set",
        { principalId: agentId, treePath: "proj", access: 2 },
        as,
      )
    ).granted,
  ).toBe(true);

  // but the member cannot manage the roster, add a stranger, or grant to others
  await expectAppError(call("principal.list", {}, as), "FORBIDDEN");
  const stranger = await makeUser();
  await expectAppError(
    call("principal.add", { principalId: stranger }, as),
    "FORBIDDEN",
  );
  await expectAppError(
    call(
      "grant.set",
      { principalId: stranger, treePath: "proj", access: 1 },
      as,
    ),
    "FORBIDDEN",
  );
});
