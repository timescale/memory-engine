// Integration test for the user RPC serviceAccount.* handlers.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/user/service-account.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { bootstrapSpaceDatabase, migrateCore } from "@memory.build/database";
import { coreStore } from "@memory.build/engine/core";
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

async function call<T = unknown>(
  method: string,
  params: unknown,
  asUser: string = userId,
  identity: { kind?: "u" | "a" | "s"; viaApiKey?: boolean } = {},
): Promise<T> {
  const registered = userMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const kind = identity.kind ?? "u";
  const context = {
    request: new Request("http://localhost/api/v1/user/rpc"),
    core: coreStore(sql, coreSchema),
    kind,
    userId: asUser,
    email: kind === "u" ? `${asUser}@example.com` : null,
    emailVerified: kind === "u",
    name: kind === "u" ? "Test User" : "machine",
    db: sql,
    coreSchema,
    viaApiKey: identity.viaApiKey ?? false,
    authenticatedAs: null,
  } as unknown as HandlerContext;
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

async function makeSpace(adminId: string = userId): Promise<string> {
  const core = coreStore(sql, coreSchema);
  const spaceId = await core.createSpace(rand(12), "Service Account Space");
  await core.addPrincipalToSpace(spaceId, adminId, true);
  return spaceId;
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

test("space admin can create, list, rename, and delete service accounts", async () => {
  const spaceId = await makeSpace();
  const created = await call<{
    serviceAccount: {
      id: string;
      name: string;
      adminId: string;
      spaceId: string;
    };
  }>("serviceAccount.create", {
    spaceId,
    name: "ci-bot",
    adminMembers: [],
  });

  expect(created.serviceAccount).toMatchObject({ name: "ci-bot", spaceId });

  const listed = await call<{
    serviceAccounts: { id: string; name: string }[];
  }>("serviceAccount.list", { spaceId });
  expect(listed.serviceAccounts).toContainEqual(
    expect.objectContaining({ id: created.serviceAccount.id, name: "ci-bot" }),
  );

  expect(
    (
      await call<{ renamed: boolean }>("serviceAccount.rename", {
        id: created.serviceAccount.id,
        name: "deploy-bot",
      })
    ).renamed,
  ).toBe(true);

  expect(
    (
      await call<{ deleted: boolean }>("serviceAccount.delete", {
        id: created.serviceAccount.id,
      })
    ).deleted,
  ).toBe(true);
  expect(
    await coreStore(sql, coreSchema).getPrincipal(
      created.serviceAccount.adminId,
    ),
  ).toBeNull();
});

test("admin-group members can list and rename only administered service accounts", async () => {
  const spaceId = await makeSpace();
  const managerId = await makeUser();
  await coreStore(sql, coreSchema).addPrincipalToSpace(spaceId, managerId);

  const managed = await call<{ serviceAccount: { id: string; name: string } }>(
    "serviceAccount.create",
    {
      spaceId,
      name: "managed-bot",
      adminMembers: [{ memberId: managerId }],
    },
  );
  await call("serviceAccount.create", {
    spaceId,
    name: "other-bot",
    adminMembers: [],
  });

  const listed = await call<{ serviceAccounts: { id: string }[] }>(
    "serviceAccount.list",
    { spaceId },
    managerId,
  );
  expect(listed.serviceAccounts.map((a) => a.id)).toEqual([
    managed.serviceAccount.id,
  ]);

  expect(
    (
      await call<{ renamed: boolean }>(
        "serviceAccount.rename",
        { id: managed.serviceAccount.id, name: "renamed-bot" },
        managerId,
      )
    ).renamed,
  ).toBe(true);
  await expectAppError(
    call("serviceAccount.delete", { id: managed.serviceAccount.id }, managerId),
    "FORBIDDEN",
  );
});

test("ordinary users cannot create or rename service accounts", async () => {
  const spaceId = await makeSpace();
  const memberId = await makeUser();
  await coreStore(sql, coreSchema).addPrincipalToSpace(spaceId, memberId);
  const created = await call<{ serviceAccount: { id: string } }>(
    "serviceAccount.create",
    { spaceId, name: "admin-bot", adminMembers: [] },
  );

  await expectAppError(
    call(
      "serviceAccount.create",
      { spaceId, name: "x", adminMembers: [] },
      memberId,
    ),
    "FORBIDDEN",
  );
  await expectAppError(
    call(
      "serviceAccount.rename",
      { id: created.serviceAccount.id, name: "x" },
      memberId,
    ),
    "FORBIDDEN",
  );
  const listed = await call<{ serviceAccounts: unknown[] }>(
    "serviceAccount.list",
    { spaceId },
    memberId,
  );
  expect(listed.serviceAccounts).toEqual([]);
});

test("service-account admins can manage service-account api keys", async () => {
  const spaceId = await makeSpace();
  const managerId = await makeUser();
  await coreStore(sql, coreSchema).addPrincipalToSpace(spaceId, managerId);
  const createdAccount = await call<{ serviceAccount: { id: string } }>(
    "serviceAccount.create",
    {
      spaceId,
      name: "keyed-bot",
      adminMembers: [{ memberId: managerId, admin: true }],
    },
  );

  const key = await call<{ id: string; key: string }>(
    "apiKey.create",
    {
      memberId: createdAccount.serviceAccount.id,
      name: "deploy",
      expiresAt: null,
    },
    managerId,
  );
  expect(key.key).toMatch(/^me\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);

  const listed = await call<{ apiKeys: { id: string }[] }>(
    "apiKey.list",
    { memberId: createdAccount.serviceAccount.id },
    managerId,
  );
  expect(listed.apiKeys.map((k) => k.id)).toContain(key.id);

  await expectAppError(
    call(
      "apiKey.create",
      {
        memberId: createdAccount.serviceAccount.id,
        name: "sibling",
        expiresAt: null,
      },
      managerId,
      { viaApiKey: true },
    ),
    "FORBIDDEN",
  );
  await expectAppError(
    call(
      "apiKey.list",
      { memberId: createdAccount.serviceAccount.id },
      createdAccount.serviceAccount.id,
      {
        kind: "s",
        viaApiKey: true,
      },
    ),
    "FORBIDDEN",
  );
});

test("non-user callers are denied before serviceAccount param validation", async () => {
  const serviceAccountId = await coreStore(sql, coreSchema)
    .createServiceAccount(await makeSpace(), "machine")
    .then((a) => a.id);
  const request = new Request("http://localhost/api/v1/user/rpc", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "serviceAccount.create",
      params: { not: "valid" },
      id: 1,
    }),
  });
  const response = await handleRpcRequest(request, userMethods, {
    core: coreStore(sql, coreSchema),
    kind: "s",
    userId: serviceAccountId,
    email: null,
    emailVerified: false,
    name: "machine",
    db: sql,
    coreSchema,
    viaApiKey: true,
    authenticatedAs: null,
  } as unknown as HandlerContext);

  const body = JSON.stringify(await response.json());
  expect(body).toContain("user-only");
});
