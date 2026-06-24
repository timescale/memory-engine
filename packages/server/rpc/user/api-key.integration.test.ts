// Integration test for the user RPC api-key handlers (apiKey.* lifecycle).
// A key is minted for a member the caller owns — an agent, or the caller's OWN
// user principal (a personal access token). Keys are global (no space slug) and
// minting needs only ownership, not space membership. Minting/revoking is
// session-only: a key-authenticated caller (viaApiKey) can't manage keys.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/user/api-key.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { bootstrapSpaceDatabase, migrateCore } from "@memory.build/database";
import { coreStore } from "@memory.build/engine/core";
import { type AppErrorCode, isAppError } from "@memory.build/protocol/errors";
import postgres, { type Sql } from "postgres";
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

function call<T = unknown>(
  method: string,
  params: unknown,
  asUser: string = userId,
  opts: { viaApiKey?: boolean } = {},
): Promise<T> {
  const registered = userMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const context = {
    request: new Request("http://localhost/api/v1/user/rpc"),
    core: coreStore(sql, coreSchema),
    userId: asUser,
    db: sql,
    coreSchema,
    viaApiKey: opts.viaApiKey ?? false,
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

async function makeUser(): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  const id = row?.id as string;
  await coreStore(sql, coreSchema).createUser(id, `u_${rand(8)}@example.com`);
  return id;
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand(8)}`;
  await bootstrapSpaceDatabase(sql);
  await migrateCore(sql, { schema: coreSchema });
});

afterAll(async () => {
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

beforeEach(async () => {
  userId = await makeUser();
});

test("create (global, no space needed) / list / get / delete", async () => {
  // The agent is owned by the caller but is NOT a member of any space — key
  // creation depends only on ownership, not space membership.
  const { id: agentId } = await call<{ id: string }>("agent.create", {
    name: "bot",
  });

  const created = await call<{ id: string; key: string }>("apiKey.create", {
    memberId: agentId,
    name: "ci",
    expiresAt: null,
  });
  // Global format: me.<lookupId>.<secret> — no space slug.
  expect(created.key).toMatch(/^me\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);

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

test("mints a personal access token for the caller's own user principal", async () => {
  const created = await call<{ id: string; key: string }>("apiKey.create", {
    memberId: userId, // self → a PAT
    name: "my-pat",
    expiresAt: null,
  });
  expect(created.key).toMatch(/^me\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);
  // It's listed under the user's own member id.
  const list = await call<{ apiKeys: { id: string }[] }>("apiKey.list", {
    memberId: userId,
  });
  expect(list.apiKeys.map((k) => k.id)).toContain(created.id);
});

test("a key-authenticated caller can't mint or revoke keys (keys can't manage keys)", async () => {
  // First mint a key as a session caller (viaApiKey defaults false).
  const created = await call<{ id: string }>("apiKey.create", {
    memberId: userId,
    name: "pat",
    expiresAt: null,
  });
  // Now the same ops via a key (viaApiKey) are forbidden — even for self.
  await expectAppError(
    call(
      "apiKey.create",
      { memberId: userId, name: "sibling", expiresAt: null },
      userId,
      { viaApiKey: true },
    ),
    "FORBIDDEN",
  );
  await expectAppError(
    call("apiKey.delete", { id: created.id }, userId, { viaApiKey: true }),
    "FORBIDDEN",
  );
  // Read-only ops remain available to a key caller.
  const got = await call<{ apiKey: { id: string } | null }>(
    "apiKey.get",
    { id: created.id },
    userId,
    { viaApiKey: true },
  );
  expect(got.apiKey?.id).toBe(created.id);
});

test("cannot manage keys for another user's agent", async () => {
  const { id: agentId } = await call<{ id: string }>("agent.create", {
    name: "mine",
  });
  const intruder = await makeUser();
  await expectAppError(
    call(
      "apiKey.create",
      { memberId: agentId, name: "x", expiresAt: null },
      intruder,
    ),
    "FORBIDDEN",
  );
  await expectAppError(
    call("apiKey.list", { memberId: agentId }, intruder),
    "FORBIDDEN",
  );
});

test("apiKey.get is null for an unknown key id", async () => {
  const [row] = await sql`select uuidv7() as id`;
  const got = await call<{ apiKey: unknown }>("apiKey.get", {
    id: row?.id as string,
  });
  expect(got.apiKey).toBeNull();
});
