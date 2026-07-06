// Integration test for the user RPC space handlers (space.create) with the
// custom-space flags: home-grant suppression + creator god mode, and the
// default-group name/grants/existence knobs surfaced on space.list.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/user/space.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  bootstrapSpaceDatabase,
  migrateCore,
  slugToSchema,
} from "@memory.build/database";
import { ACCESS, coreStore, ROOT_PATH } from "@memory.build/engine/core";
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
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
const createdSpaceSchemas: string[] = [];

async function call<T = unknown>(
  method: string,
  params: unknown,
  asUser: string = userId,
): Promise<T> {
  const registered = userMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const context = {
    request: new Request("http://localhost/api/v1/user/rpc"),
    core: coreStore(sql, coreSchema),
    kind: "u",
    userId: asUser,
    email: `${asUser}@example.com`,
    name: "Test User",
    db: sql,
    coreSchema,
  } as unknown as HandlerContext;
  registered.authorize?.(context);
  return registered.handler(params, context) as Promise<T>;
}

async function makeUser(): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  const id = row?.id as string;
  await coreStore(sql, coreSchema).createUser(id, `u_${rand(8)}@example.com`);
  return id;
}

async function createSpace(params: {
  name: string;
  autoGrantHome?: boolean;
  defaultGroupName?: string | null;
  defaultGroupGrants?: boolean;
}): Promise<{ id: string; slug: string }> {
  const res = await call<{ id: string; slug: string }>("space.create", params);
  createdSpaceSchemas.push(slugToSchema(res.slug));
  return res;
}

/** The caller's view of a space from space.list. */
async function spaceListEntry(
  spaceId: string,
  asUser: string = userId,
): Promise<MemberSpaceResponse | undefined> {
  const res = await call<{ spaces: MemberSpaceResponse[] }>(
    "space.list",
    {},
    asUser,
  );
  return res.spaces.find((s) => s.id === spaceId);
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

test("space.create (defaults): creator gets admin + owner@~ + owner@/share; a granted 'team' default group", async () => {
  const core = coreStore(sql, coreSchema);
  const { id: spaceId } = await createSpace({ name: "Standard" });

  const grants = await core.listTreeAccessGrants(spaceId, userId);
  const paths = grants.map((g) => g.treePath);
  // owner@~ (home.<id>) + owner@/share; no owner@root
  expect(paths.some((p) => p.startsWith("home."))).toBe(true);
  expect(paths).toContain("share");
  expect(paths).not.toContain(ROOT_PATH);
  for (const g of grants) expect(g.access).toBe(ACCESS.owner);

  const entry = await spaceListEntry(spaceId);
  expect(entry?.admin).toBe(true);
  expect(entry?.autoGrantHome).toBe(true);
  expect(entry?.defaultGroup?.name).toBe("team");
});

test("space.create (autoGrantHome=false, no default group): creator god mode; a joiner is locked out", async () => {
  const core = coreStore(sql, coreSchema);
  const { id: spaceId } = await createSpace({
    name: "Custom",
    autoGrantHome: false,
    defaultGroupName: null,
  });

  // creator: admin + owner@root (god mode), and NO owner@~
  const grants = await core.listTreeAccessGrants(spaceId, userId);
  const paths = grants.map((g) => g.treePath);
  expect(paths).toContain(ROOT_PATH); // owner@/
  expect(paths.some((p) => p.startsWith("home."))).toBe(false);
  expect(grants.find((g) => g.treePath === ROOT_PATH)?.access).toBe(
    ACCESS.owner,
  );

  const entry = await spaceListEntry(spaceId);
  expect(entry?.admin).toBe(true);
  expect(entry?.autoGrantHome).toBe(false);
  expect(entry?.defaultGroup).toBeNull();
  // no default group was provisioned
  expect(await core.listSpaceGroups(spaceId)).toHaveLength(0);

  // a fresh joiner gets zero grants → auth gate would deny them
  const joiner = await makeUser();
  await core.addPrincipalToSpace(spaceId, joiner);
  expect(await core.buildTreeAccess(joiner, spaceId)).toEqual([]);
});

test("space.create --default-group readers --no-default-group-grants: named grantless default group", async () => {
  const core = coreStore(sql, coreSchema);
  const { id: spaceId } = await createSpace({
    name: "Readers",
    defaultGroupName: "readers",
    defaultGroupGrants: false,
  });

  const groups = await core.listSpaceGroups(spaceId);
  expect(groups.map((g) => g.name)).toEqual(["readers"]);
  const readersId = groups[0]?.id ?? "";
  // grantless: the default group has no tree_access of its own
  expect(await core.listTreeAccessGrants(spaceId, readersId)).toEqual([]);

  const entry = await spaceListEntry(spaceId);
  expect(entry?.defaultGroup?.name).toBe("readers");
  // home grants are still on by default here (only the group is customized)
  expect(entry?.autoGrantHome).toBe(true);
});
