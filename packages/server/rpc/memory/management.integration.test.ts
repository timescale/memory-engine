// Integration test for the space management handlers (4C-2b): member / agent /
// group / grant / apiKey, driven through the merged memory registry against a
// provisioned space. The provisioned owner has owner@root, satisfying the
// management authorization gate.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/memory/management.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import { core as engineCore, space as engineSpace } from "@memory.build/engine";
import type { TreeAccess } from "@memory.build/engine/core";
import { type AppErrorCode, isAppError } from "@memory.build/protocol/errors";
import postgres, { type Sql } from "postgres";
import { provisionUser } from "../../provision";
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
let authSchema: string;
let coreSchema: string;
const createdSpaceSchemas: string[] = [];

let ownerTreeAccess: TreeAccess;
let space: { id: string; slug: string };
let ownerId: string;
let ownerEmail: string;

function call<T = unknown>(
  method: string,
  params: unknown,
  as: { principalId?: string; treeAccess?: TreeAccess; admin?: boolean } = {},
): Promise<T> {
  const registered = memoryMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const context = {
    request: new Request("http://localhost/api/v1/memory/rpc"),
    store: engineSpace.spaceStore(sql, `me_${space.slug}`),
    core: engineCore.coreStore(sql, coreSchema),
    space,
    principalId: as.principalId ?? ownerId,
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
 * its id. Not yet a member of any space — member.add brings it in.
 */
function makeAgent(owner: string): Promise<string> {
  return engineCore
    .coreStore(sql, coreSchema)
    .createAgent(owner, `agent_${rand(6)}`);
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  authSchema = `auth_test_${rand(8)}`;
  coreSchema = `core_test_${rand(8)}`;
  await bootstrapSpaceDatabase(sql);
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

beforeEach(async () => {
  ownerEmail = `owner_${crypto.randomUUID().slice(0, 8)}@example.com`;
  const r = await provisionUser(
    sql,
    { auth: authSchema, core: coreSchema },
    {
      email: ownerEmail,
      name: "Owner",
      provider: "github",
      accountId: crypto.randomUUID(),
    },
  );
  createdSpaceSchemas.push(`me_${r.spaceSlug}`);
  space = { id: r.spaceId, slug: r.spaceSlug };
  ownerId = r.userId;
  ownerTreeAccess = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(r.userId, r.spaceId);
});

test("member: list / resolveByEmail / add / remove", async () => {
  const listed = await call<{ members: { id: string; admin: boolean }[] }>(
    "member.list",
    {},
  );
  expect(listed.members.some((m) => m.id === ownerId && m.admin)).toBe(true);

  const resolved = await call<{ principal: { id: string } | null }>(
    "member.resolveByEmail",
    { email: ownerEmail },
  );
  expect(resolved.principal?.id).toBe(ownerId);

  const other = await makeUser();
  expect(
    (await call<{ added: boolean }>("member.add", { principalId: other }))
      .added,
  ).toBe(true);
  expect(
    (await call<{ members: { id: string }[] }>("member.list", {})).members.some(
      (m) => m.id === other,
    ),
  ).toBe(true);
  expect(
    (await call<{ removed: boolean }>("member.remove", { principalId: other }))
      .removed,
  ).toBe(true);
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

test("grant: set / list / remove", async () => {
  const other = await makeUser();
  await call("grant.set", { principalId: other, treePath: "docs", access: 1 });
  const grants = await call<{
    grants: { principalId: string; treePath: string; access: number }[];
  }>("grant.list", { principalId: other });
  expect(grants.grants).toHaveLength(1);
  expect(grants.grants[0]?.treePath).toBe("docs");
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

test("apiKey: create (agent-only) / list / get / delete", async () => {
  // agent lifecycle is the user endpoint's job; here the owner brings an agent
  // into the space, then mints its (space-bound) key.
  const agentId = await makeAgent(ownerId);
  await call("member.add", { principalId: agentId });
  const created = await call<{ id: string; key: string }>("apiKey.create", {
    agentId,
    name: "ci",
  });
  expect(created.key.startsWith(`me.${space.slug}.`)).toBe(true);

  const list = await call<{ apiKeys: { id: string }[] }>("apiKey.list", {
    memberId: agentId,
  });
  expect(list.apiKeys.map((k) => k.id)).toContain(created.id);

  const got = await call<{ apiKey: { id: string } | null }>("apiKey.get", {
    id: created.id,
  });
  expect(got.apiKey?.id).toBe(created.id);

  expect(
    (await call<{ deleted: boolean }>("apiKey.delete", { id: created.id }))
      .deleted,
  ).toBe(true);
  expect(
    (await call<{ apiKey: unknown }>("apiKey.get", { id: created.id })).apiKey,
  ).toBeNull();
});

test("apiKey.create rejects a non-agent member", async () => {
  // ownerId is a user, not an agent → NOT_FOUND in this space's agents
  await expectAppError(
    call("apiKey.create", { agentId: ownerId, name: "nope" }),
    "NOT_FOUND",
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
  await expectAppError(call("member.list", {}, as), "FORBIDDEN");
  await expectAppError(call("group.create", { name: "x" }, as), "FORBIDDEN");
});

test("a space admin (without owner@root) has management authority", async () => {
  // an admin member with only read access, no owner grant anywhere
  const adminMember = await makeUser();
  await call("member.add", { principalId: adminMember, admin: true });
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
    (await call<{ members: unknown[] }>("member.list", {}, as)).members.length,
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

test("group member management allows a group admin (not a space admin)", async () => {
  // owner creates a group and makes `lead` an admin of it
  const { id: groupId } = await call<{ id: string }>("group.create", {
    name: "team",
  });
  const lead = await makeUser();
  // lead is only a group admin (not added to principal_space) — group
  // membership is transitive, so this is enough authority over the group
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

test("group management requires admin — owner@root is not enough", async () => {
  // a member who owns the whole data tree (owner@root) but is NOT a space admin
  const member = await makeUser();
  await call("member.add", { principalId: member });
  await call("grant.set", { principalId: member, treePath: "", access: 3 });
  const ta = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(member, space.id);
  const as = { principalId: member, treeAccess: ta, admin: false };

  // owner@root can manage the roster and grant access (it's their data)
  expect(
    (await call<{ members: unknown[] }>("member.list", {}, as)).members.length,
  ).toBeGreaterThan(0);
  // but groups are structural — admin only
  await expectAppError(call("group.create", { name: "g" }, as), "FORBIDDEN");
});

test("grant authority is path-scoped: a subtree owner delegates within it", async () => {
  // a member who owns "proj" (not the root) can manage access under proj only
  const member = await makeUser();
  await call("member.add", { principalId: member });
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
  expect(underProj.grants.some((g) => g.treePath === "proj.sub")).toBe(true);
  await expectAppError(call("grant.list", {}, as), "FORBIDDEN");
});

test("self-service: a non-owner member brings their own agent into the space", async () => {
  // owner onboards a second user with write (not owner) on a subtree
  const member = await makeUser();
  await call("member.add", { principalId: member });
  await call("grant.set", { principalId: member, treePath: "proj", access: 2 });
  const memberTA = await engineCore
    .coreStore(sql, coreSchema)
    .buildTreeAccess(member, space.id);
  const as = { principalId: member, treeAccess: memberTA };

  // the member created their agent on the user endpoint (simulated via core);
  // they bring it into the space (self-service member.add) without owner rights
  const agentId = await makeAgent(member);
  expect(
    (await call<{ added: boolean }>("member.add", { principalId: agentId }, as))
      .added,
  ).toBe(true);

  // and mint its key + self-grant it (capped by their own access)
  const key = await call<{ key: string }>(
    "apiKey.create",
    { agentId, name: "k" },
    as,
  );
  expect(key.key.startsWith(`me.${space.slug}.`)).toBe(true);
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
  await expectAppError(call("member.list", {}, as), "FORBIDDEN");
  const stranger = await makeUser();
  await expectAppError(
    call("member.add", { principalId: stranger }, as),
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
