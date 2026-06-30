// Integration test for the invitee-side user RPC: invite.pending/accept/decline
// (email-keyed, verified-email-gated) and space.ensureDefault (zero-space
// onboarding). Exercises the real handlers against a core schema.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/rpc/user/invitation.integration.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { bootstrapSpaceDatabase, migrateCore } from "@memory.build/database";
import { ACCESS, coreStore } from "@memory.build/engine/core";
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
let userEmail: string;
const createdSpaceSchemas: string[] = [];

/**
 * Invoke a user-RPC method as the test user, mirroring the dispatcher (per-method
 * authorize gate before the handler). The identity mirrors what the middleware
 * resolves; `emailVerified` defaults to true (an OAuth login) and can be
 * overridden to exercise the verified-email gate.
 */
async function call<T = unknown>(
  method: string,
  params: unknown,
  opts: {
    asUser?: string;
    email?: string | null;
    kind?: "u" | "a";
    emailVerified?: boolean;
  } = {},
): Promise<T> {
  const registered = userMethods.get(method);
  if (!registered) throw new Error(`no handler for ${method}`);
  const kind = opts.kind ?? "u";
  const asUser = opts.asUser ?? userId;
  const context = {
    request: new Request("http://localhost/api/v1/user/rpc"),
    core: coreStore(sql, coreSchema),
    kind,
    userId: asUser,
    email: kind === "a" ? null : (opts.email ?? userEmail),
    name: "Test User",
    emailVerified: kind === "a" ? false : (opts.emailVerified ?? true),
    db: sql,
    coreSchema,
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

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand(8)}`;
  await bootstrapSpaceDatabase(sql); // extensions for me_<slug> (ensureDefault)
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
  const [row] = await sql`select uuidv7() as id`;
  userId = row?.id as string;
  userEmail = `u_${rand(8)}@example.com`;
  await coreStore(sql, coreSchema).createUser(userId, userEmail);
});

test("space.ensureDefault creates a space at zero, then is a no-op", async () => {
  const first = await call<{
    created: boolean;
    space: { slug: string; name: string } | null;
  }>("space.ensureDefault", {});
  expect(first.created).toBe(true);
  expect(first.space).not.toBeNull();
  if (first.space) createdSpaceSchemas.push(`me_${first.space.slug}`);

  // Already has a space → a no-op.
  const second = await call<{ created: boolean; space: unknown }>(
    "space.ensureDefault",
    {},
  );
  expect(second.created).toBe(false);
  expect(second.space).toBeNull();

  const core = coreStore(sql, coreSchema);
  expect(await core.listSpacesForMember(userId)).toHaveLength(1);
});

test("invite.pending → accept joins the space; pending then empties", async () => {
  const core = coreStore(sql, coreSchema);
  const inviterId = (await sql`select uuidv7() as id`)[0]?.id as string;
  await core.createUser(inviterId, `inviter_${rand(8)}@example.com`);
  const spaceId = await core.createSpace(rand(12), "Invited");
  await core.createSpaceInvitation(spaceId, userEmail, {
    admin: true,
    shareAccess: ACCESS.write,
    invitedBy: inviterId,
  });

  const pending = await call<{
    invitations: { invitationId: string; spaceSlug: string }[];
  }>("invite.pending", {});
  expect(pending.invitations).toHaveLength(1);
  const invitationId = pending.invitations[0]?.invitationId as string;

  const accepted = await call<{ spaceSlug: string; spaceName: string }>(
    "invite.accept",
    { invitationId },
  );
  expect(accepted.spaceName).toBe("Invited");

  expect(
    (await core.listSpacesForMember(userId)).some((s) => s.id === spaceId),
  ).toBe(true);
  // No longer pending; re-accept is NOT_FOUND.
  expect(
    (await call<{ invitations: unknown[] }>("invite.pending", {})).invitations,
  ).toHaveLength(0);
  await expectAppError(call("invite.accept", { invitationId }), "NOT_FOUND");
});

test("invite.decline removes a pending invitation", async () => {
  const core = coreStore(sql, coreSchema);
  const inviterId = (await sql`select uuidv7() as id`)[0]?.id as string;
  await core.createUser(inviterId, `inviter_${rand(8)}@example.com`);
  const spaceId = await core.createSpace(rand(12), "DeclineMe");
  await core.createSpaceInvitation(spaceId, userEmail, {
    admin: false,
    shareAccess: null,
    invitedBy: inviterId,
  });

  const pending = await call<{
    invitations: { invitationId: string }[];
  }>("invite.pending", {});
  const invitationId = pending.invitations[0]?.invitationId as string;

  const declined = await call<{ declined: boolean }>("invite.decline", {
    invitationId,
  });
  expect(declined.declined).toBe(true);
  expect(
    (await call<{ invitations: unknown[] }>("invite.pending", {})).invitations,
  ).toHaveLength(0);
  // Not a member.
  expect(
    (await core.listSpacesForMember(userId)).some((s) => s.id === spaceId),
  ).toBe(false);
});

test("invitee methods require a verified email", async () => {
  await expectAppError(
    call("invite.pending", {}, { emailVerified: false }),
    "FORBIDDEN",
  );
  await expectAppError(
    call(
      "invite.accept",
      { invitationId: crypto.randomUUID() },
      {
        emailVerified: false,
      },
    ),
    "FORBIDDEN",
  );
});

test("an agent caller is denied the invitee methods", async () => {
  await expectAppError(call("invite.pending", {}, { kind: "a" }), "FORBIDDEN");
});

test("invite.redeem joins via an open magic link (no email match needed)", async () => {
  const core = coreStore(sql, coreSchema);
  const inviterId = (await sql`select uuidv7() as id`)[0]?.id as string;
  await core.createUser(inviterId, `inviter_${rand(8)}@example.com`);
  const spaceId = await core.createSpace(rand(12), "LinkSpace");
  const { token } = await core.createSpaceInvitation(spaceId, null, {
    admin: false,
    shareAccess: ACCESS.read,
    invitedBy: inviterId,
  });

  const joined = await call<{ spaceSlug: string; spaceName: string }>(
    "invite.redeem",
    { token },
  );
  expect(joined.spaceName).toBe("LinkSpace");
  expect(
    (await core.listSpacesForMember(userId)).some((s) => s.id === spaceId),
  ).toBe(true);

  // a bogus token is NOT_FOUND
  await expectAppError(call("invite.redeem", { token: "nope" }), "NOT_FOUND");
});
