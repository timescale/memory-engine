// Integration test for the user RPC agent handlers (agent.* lifecycle).
// User-scoped (no space): a user manages their own global service accounts.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/user/agent.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { migrateCore } from "@memory.build/database";
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
): Promise<T> {
  const registered = userMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const context = {
    request: new Request("http://localhost/api/v1/user/rpc"),
    core: coreStore(sql, coreSchema),
    userId: asUser,
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
  await migrateCore(sql, { schema: coreSchema });
});

afterAll(async () => {
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

beforeEach(async () => {
  userId = await makeUser();
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
