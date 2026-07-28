// Integration test for the user RPC api-key handlers (apiKey.* lifecycle).
// A key is minted for the caller's own user principal (a personal access token)
// or a service account they administer. Keys are global (no space slug) and
// minting/revoking is
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
    // These tests exercise the user-PAT carve-out (a key-authenticated user).
    kind: "u",
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
  const created = await call<{ id: string; key: string }>("apiKey.create", {
    memberId: userId,
    name: "ci",
    expiresAt: null,
  });
  // Global format: me.<lookupId>.<secret> — no space slug.
  expect(created.key).toMatch(/^me\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);

  const list = await call<{
    apiKeys: { id: string; lastUsedOn: string | null }[];
  }>("apiKey.list", {
    memberId: userId,
  });
  expect(list.apiKeys.map((k) => k.id)).toContain(created.id);
  expect(list.apiKeys.find((k) => k.id === created.id)?.lastUsedOn).toBeNull();

  await coreStore(sql, coreSchema).touchApiKey(created.id, "2026-07-17");

  const got = await call<{
    apiKey: { id: string; lastUsedOn: string | null } | null;
  }>("apiKey.get", { id: created.id });
  expect(got.apiKey?.id).toBe(created.id);
  expect(got.apiKey?.lastUsedOn).toBe("2026-07-17");

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

test("creates and inspects a scoped PAT", async () => {
  const core = coreStore(sql, coreSchema);
  const slug = rand(12);
  const spaceId = await core.createSpace(slug, "Scoped");
  await core.addPrincipalToSpace(spaceId, userId);

  const created = await call<{ id: string }>("apiKey.create", {
    memberId: userId,
    name: "scoped-pat",
    expiresAt: null,
    access: [
      {
        spaceId,
        spaceAdmin: false,
        grants: [{ treePath: "/share/deploy", access: 2 }],
      },
    ],
  });
  const got = await call<{
    apiKey: { restricted: boolean } | null;
    access: Array<{
      spaceId: string;
      slug: string;
      spaceAdmin: boolean;
      grants: Array<{ treePath: string; access: number }>;
    }>;
  }>("apiKey.get", { id: created.id });
  expect(got.apiKey?.restricted).toBe(true);
  expect(got.access).toEqual([
    {
      spaceId,
      slug,
      spaceAdmin: false,
      grants: [{ treePath: "share.deploy", access: 2 }],
    },
  ]);
});

test("rejects scoped declarations outside the holder's direct memberships", async () => {
  const spaceId = await coreStore(sql, coreSchema).createSpace(
    rand(12),
    "Other",
  );
  await expectAppError(
    call("apiKey.create", {
      memberId: userId,
      name: "invalid-scoped-pat",
      expiresAt: null,
      access: [{ spaceId, grants: [] }],
    }),
    "VALIDATION_ERROR",
  );
});

test("rejects duplicate normalized scope paths", async () => {
  const core = coreStore(sql, coreSchema);
  const spaceId = await core.createSpace(rand(12), "Scoped");
  await core.addPrincipalToSpace(spaceId, userId);

  await expectAppError(
    call("apiKey.create", {
      memberId: userId,
      name: "duplicate-scoped-pat",
      expiresAt: null,
      access: [
        {
          spaceId,
          grants: [
            { treePath: "/share/deploy", access: 1 },
            { treePath: "share.deploy", access: 2 },
          ],
        },
      ],
    }),
    "VALIDATION_ERROR",
  );
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

test("managing keys for another user is FORBIDDEN, not NOT_FOUND", async () => {
  // The target principal exists (another user), but the caller may not manage
  // its keys — the error must be FORBIDDEN, not a misleading NOT_FOUND.
  const other = await makeUser();
  await expectAppError(
    call("apiKey.create", { memberId: other, name: "x", expiresAt: null }),
    "FORBIDDEN",
  );
  await expectAppError(call("apiKey.list", { memberId: other }), "FORBIDDEN");
});

test("managing keys for an unknown member is NOT_FOUND", async () => {
  const [row] = await sql`select uuidv7() as id`;
  await expectAppError(
    call("apiKey.list", { memberId: row?.id as string }),
    "NOT_FOUND",
  );
});

test("apiKey.get is null for an unknown key id", async () => {
  const [row] = await sql`select uuidv7() as id`;
  const got = await call<{ apiKey: unknown }>("apiKey.get", {
    id: row?.id as string,
  });
  expect(got.apiKey).toBeNull();
});
