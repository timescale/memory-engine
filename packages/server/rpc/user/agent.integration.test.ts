// Integration test for the user RPC agent handlers (agent.* lifecycle).
// User-scoped (no space): a user manages their own global service accounts.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/user/agent.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { bootstrapSpaceDatabase, migrateCore } from "@memory.build/database";
import { ACCESS, coreStore, ROOT_PATH } from "@memory.build/engine/core";
import { type AppErrorCode, isAppError } from "@memory.build/protocol/errors";
import postgres, { type Sql } from "postgres";
import { handleRpcRequest } from "../handler";
import type { HandlerContext } from "../types";
import { userMethods } from "./index";

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
let userId: string;
const createdSpaceSchemas: string[] = [];

async function call<T = unknown>(
  method: string,
  params: unknown,
  asUser: string = userId,
  identity?: { email?: string; name?: string; kind?: "u" | "a" },
): Promise<T> {
  const registered = userMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const kind = identity?.kind ?? "u";
  const context = {
    request: new Request("http://localhost/api/v1/user/rpc"),
    core: coreStore(sql, coreSchema),
    // Identity the middleware (authenticateUser) would have put on the context
    // from the validated credential; whoami echoes it. An agent carries no
    // email (kind "a"); the account-management methods reject it.
    kind,
    userId: asUser,
    email: kind === "a" ? null : (identity?.email ?? `${asUser}@example.com`),
    name: identity?.name ?? "Test User",
    db: sql,
    coreSchema,
  } as unknown as HandlerContext;
  // Mirror the dispatcher: per-method authorization (the agent allow-list gate)
  // runs before the handler. async, so a denial surfaces as a rejected promise.
  registered.authorize?.(context);
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

async function makeUser(): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  const id = row?.id as string;
  await coreStore(sql, coreSchema).createUser(id, `u_${rand(8)}@example.com`);
  return id;
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand(8)}`;
  await bootstrapSpaceDatabase(sql); // extensions for me_<slug> (space.create)
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
  userId = await makeUser();
});

test("whoami echoes the validated session identity", async () => {
  // Under the new model whoami trusts the identity the middleware resolved from
  // the validated session/token (ctx.email/ctx.name) — no store lookup. Token
  // validity (e.g. a deleted user → 401) is the middleware's job, covered in the
  // authenticate-space/user integration tests.
  const me = await call<{
    id: string;
    kind: string;
    email: string | null;
    name: string;
  }>("whoami", {}, userId, { email: "who@example.com", name: "Who Am I" });
  expect(me).toEqual({
    id: userId,
    kind: "u",
    email: "who@example.com",
    name: "Who Am I",
  });
});

// An agent acting with ME_API_KEY reaches the user RPC; the door admits it and
// the handlers authorize per-method. The account-scoped *reads* work; every
// account-*management* method is user-only (requireUserCaller).
test("an agent caller can whoami (kind 'a', null email)", async () => {
  const agentId = await coreStore(sql, coreSchema).createAgent(userId, "bot");
  const me = await call<{
    id: string;
    kind: string;
    email: string | null;
    name: string;
  }>("whoami", {}, agentId, { kind: "a", name: "bot" });
  expect(me).toEqual({ id: agentId, kind: "a", email: null, name: "bot" });
});

test("an agent caller can list its own spaces (space.list)", async () => {
  const core = coreStore(sql, coreSchema);
  const agentId = await core.createAgent(userId, "bot");
  const spaceId = await core.createSpace(rand(12), "Agent Space");
  await core.addPrincipalToSpace(spaceId, agentId);

  const res = await call<{ spaces: { id: string }[] }>(
    "space.list",
    {},
    agentId,
    { kind: "a", name: "bot" },
  );
  expect(res.spaces.some((s) => s.id === spaceId)).toBe(true);
});

test("an agent caller is denied every account-management method (FORBIDDEN)", async () => {
  const agentId = await coreStore(sql, coreSchema).createAgent(userId, "bot");
  const asAgent = { kind: "a" as const, name: "bot" };
  // The gate's authorize hook (mirrored in `call`) rejects an agent before the
  // handler — and, in production, before param validation — so the param shapes
  // below are placeholders and the denial is FORBIDDEN regardless of validity.
  const denied: [string, unknown][] = [
    ["agent.create", { name: "x" }],
    ["agent.list", {}],
    ["agent.spaces", { id: agentId }],
    ["agent.rename", { id: agentId, name: "x" }],
    ["agent.delete", { id: agentId }],
    ["apiKey.create", { memberId: agentId, name: "x" }],
    ["apiKey.list", { memberId: agentId }],
    ["apiKey.get", { id: agentId }],
    ["apiKey.delete", { id: agentId }],
    ["space.create", { name: "x" }],
    ["space.rename", { slug: "a".repeat(12), name: "x" }],
    ["space.delete", { slug: "a".repeat(12) }],
  ];
  for (const [method, params] of denied) {
    await expectAppError(call(method, params, agentId, asAgent), "FORBIDDEN");
  }
});

test("through the dispatcher, a gated method denies an agent BEFORE param validation", async () => {
  // The denial is an `authorize` hook that runs before schema validation, so an
  // agent gets the user-only FORBIDDEN even when its params are invalid (rather
  // than an INVALID_PARAMS that would leak the param schema). Drive the real
  // dispatcher (which validates params) with a deliberately invalid body.
  const agentId = await coreStore(sql, coreSchema).createAgent(userId, "bot");
  const request = new Request("http://localhost/api/v1/user/rpc", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "agent.create",
      params: { not: "the right shape" }, // invalid for agent.create
      id: 1,
    }),
  });
  const response = await handleRpcRequest(request, userMethods, {
    core: coreStore(sql, coreSchema),
    kind: "a",
    userId: agentId,
    email: null,
    name: "bot",
    db: sql,
    coreSchema,
  } as unknown as HandlerContext);

  const body = JSON.stringify(await response.json());
  // The user-only message proves authorize ran first; a schema-first ordering
  // would instead surface the zod "params" validation error.
  expect(body).toContain("user-only");
});

test("create / list / rename / delete the caller's agents", async () => {
  const { id } = await call<{ id: string }>("agent.create", { name: "bot" });

  let agents = await call<{ agents: { id: string; name: string }[] }>(
    "agent.list",
    {},
  );
  expect(agents.agents).toHaveLength(1);
  expect(agents.agents[0]?.id).toBe(id);
  expect(agents.agents[0]?.name).toBe("bot");

  expect(
    (await call<{ renamed: boolean }>("agent.rename", { id, name: "bot2" }))
      .renamed,
  ).toBe(true);
  agents = await call("agent.list", {});
  expect(agents.agents[0]?.name).toBe("bot2");

  expect(
    (await call<{ deleted: boolean }>("agent.delete", { id })).deleted,
  ).toBe(true);
  expect(
    (await call<{ agents: unknown[] }>("agent.list", {})).agents,
  ).toHaveLength(0);
});

test("agent.list is scoped to the caller", async () => {
  await call("agent.create", { name: "mine" });
  const other = await makeUser();
  const otherList = await call<{ agents: unknown[] }>("agent.list", {}, other);
  expect(otherList.agents).toHaveLength(0);
});

test("agent.spaces lists spaces for an owned agent", async () => {
  const { id: agentId } = await call<{ id: string }>("agent.create", {
    name: "bot",
  });
  const core = coreStore(sql, coreSchema);
  const agentSpaceId = await core.createSpace(rand(12), "Agent Space");
  const userSpaceId = await core.createSpace(rand(12), "User Space");
  await core.addPrincipalToSpace(agentSpaceId, agentId);
  await core.addPrincipalToSpace(userSpaceId, userId, true);

  const res = await call<{
    spaces: { id: string; name: string; admin: boolean }[];
  }>("agent.spaces", { id: agentId });

  const agentSpace = res.spaces.find((s) => s.id === agentSpaceId);
  expect(agentSpace).toBeDefined();
  expect(agentSpace?.name).toBe("Agent Space");
  expect(agentSpace?.admin).toBe(false);
  expect(res.spaces.some((s) => s.id === userSpaceId)).toBe(false);
});

test("agent.spaces requires owning the agent", async () => {
  const { id } = await call<{ id: string }>("agent.create", { name: "mine" });
  const intruder = await makeUser();
  await expectAppError(call("agent.spaces", { id }, intruder), "FORBIDDEN");
});

test("agent.spaces rejects non-agent and missing principals", async () => {
  await expectAppError(call("agent.spaces", { id: userId }), "NOT_FOUND");

  const [row] = await sql`select uuidv7() as id`;
  await expectAppError(
    call("agent.spaces", { id: row?.id as string }),
    "NOT_FOUND",
  );
});

test("cannot rename/delete another user's agent", async () => {
  const { id } = await call<{ id: string }>("agent.create", { name: "mine" });
  const intruder = await makeUser();
  await expectAppError(
    call("agent.rename", { id, name: "hijacked" }, intruder),
    "FORBIDDEN",
  );
  await expectAppError(call("agent.delete", { id }, intruder), "FORBIDDEN");
});

test("rename/delete of a non-existent agent → NOT_FOUND", async () => {
  const [row] = await sql`select uuidv7() as id`;
  const ghost = row?.id as string;
  await expectAppError(
    call("agent.rename", { id: ghost, name: "x" }),
    "NOT_FOUND",
  );
});

test("space.list returns the spaces the user belongs to (with admin flag)", async () => {
  const core = coreStore(sql, coreSchema);
  const spaceId = await core.createSpace(rand(12), "My Space");
  await core.addPrincipalToSpace(spaceId, userId, true);

  const res = await call<{
    spaces: { id: string; name: string; admin: boolean }[];
  }>("space.list", {});
  const mine = res.spaces.find((s) => s.id === spaceId);
  expect(mine).toBeDefined();
  expect(mine?.name).toBe("My Space");
  expect(mine?.admin).toBe(true);

  // a brand-new user with no memberships sees no spaces
  const other = await makeUser();
  const otherList = await call<{ spaces: unknown[] }>("space.list", {}, other);
  expect(otherList.spaces).toHaveLength(0);
});

test("space.list excludes spaces reached only via group membership", async () => {
  const core = coreStore(sql, coreSchema);
  const spaceId = await core.createSpace(rand(12), "Group Space");
  const groupId = await core.createGroup(spaceId, "team");
  // the user is NOT added to principal_space — only to a group in the space
  await core.addGroupMember(spaceId, groupId, userId);

  const res = await call<{ spaces: { id: string; admin: boolean }[] }>(
    "space.list",
    {},
  );
  // group membership alone does not make the user a space member, so the space
  // is not listed
  expect(res.spaces.find((s) => s.id === spaceId)).toBeUndefined();
});

test("space.create provisions a space the caller owns + admins", async () => {
  const res = await call<{ id: string; slug: string }>("space.create", {
    name: "Fresh Space",
  });
  createdSpaceSchemas.push(`me_${res.slug}`);
  expect(res.slug).toMatch(/^[a-z0-9]{12}$/);

  // the me_<slug> data schema was provisioned
  const [row] = await sql.unsafe(
    `select exists (select 1 from information_schema.schemata where schema_name = $1) as e`,
    [`me_${res.slug}`],
  );
  expect(Boolean(row?.e)).toBe(true);

  // it shows up in the caller's spaces, as admin
  const list = await call<{ spaces: { id: string; admin: boolean }[] }>(
    "space.list",
    {},
  );
  expect(list.spaces.find((s) => s.id === res.id)?.admin).toBe(true);

  // the creator owns the shared root (and its home), not owner@root
  const ta = await coreStore(sql, coreSchema).buildTreeAccess(userId, res.id);
  expect(ta).toContainEqual({ tree_path: "share", access: ACCESS.owner });
  expect(ta).not.toContainEqual({ tree_path: ROOT_PATH, access: ACCESS.owner });
});

test("space.rename renames; space.delete removes the space + schema", async () => {
  const created = await call<{ id: string; slug: string }>("space.create", {
    name: "Temp Space",
  });
  const schema = `me_${created.slug}`;
  createdSpaceSchemas.push(schema);

  // rename
  expect(
    (
      await call<{ renamed: boolean }>("space.rename", {
        slug: created.slug,
        name: "Renamed Space",
      })
    ).renamed,
  ).toBe(true);
  const after = await call<{ spaces: { id: string; name: string }[] }>(
    "space.list",
    {},
  );
  expect(after.spaces.find((s) => s.id === created.id)?.name).toBe(
    "Renamed Space",
  );

  // delete: core row gone + data schema dropped
  expect(
    (await call<{ deleted: boolean }>("space.delete", { slug: created.slug }))
      .deleted,
  ).toBe(true);
  const gone = await call<{ spaces: { id: string }[] }>("space.list", {});
  expect(gone.spaces.some((s) => s.id === created.id)).toBe(false);
  const [row] = await sql.unsafe(
    `select exists (select 1 from information_schema.schemata where schema_name = $1) as e`,
    [schema],
  );
  expect(Boolean(row?.e)).toBe(false);
});

test("space.rename/delete require space admin", async () => {
  const created = await call<{ id: string; slug: string }>("space.create", {
    name: "Owned Space",
  });
  createdSpaceSchemas.push(`me_${created.slug}`);
  // a different user who is not a member/admin
  const intruder = await makeUser();
  await expectAppError(
    call("space.rename", { slug: created.slug, name: "Hijacked" }, intruder),
    "FORBIDDEN",
  );
  await expectAppError(
    call("space.delete", { slug: created.slug }, intruder),
    "FORBIDDEN",
  );
});

test("space.list lists only direct memberships; admin reflects an admin group", async () => {
  const core = coreStore(sql, coreSchema);
  const spaceId = await core.createSpace(rand(12), "Admin Group Space");
  const groupId = await core.createGroup(spaceId, "admins");
  // designate the group itself as an admin member of the space
  await core.addPrincipalToSpace(spaceId, groupId, true);
  // the user is only in that group (no direct principal_space row), so group
  // membership alone does not make them a space member
  await core.addGroupMember(spaceId, groupId, userId);

  let res = await call<{ spaces: { id: string; admin: boolean }[] }>(
    "space.list",
    {},
  );
  expect(res.spaces.find((s) => s.id === spaceId)).toBeUndefined();

  // once a direct member, the space is listed and admin is inherited via the group
  await core.addPrincipalToSpace(spaceId, userId); // direct, non-admin
  res = await call<{ spaces: { id: string; admin: boolean }[] }>(
    "space.list",
    {},
  );
  const mine = res.spaces.find((s) => s.id === spaceId);
  expect(mine).toBeDefined();
  expect(mine?.admin).toBe(true); // admin via the admin group, now that they're a member
});
