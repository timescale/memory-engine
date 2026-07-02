// Integration test for user-RPC authentication (authenticateUser).
//
// Covers the admitted credentials: an OAuth access token and the user's OWN api
// key (a PAT) authenticate as the user (kind 'u'); an AGENT api key is admitted
// as kind 'a' (per-method authz, not a door bar, keeps it off account
// management); invalid/missing → 401.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/middleware/authenticate-user.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import { AS_AGENT_HEADER } from "@memory.build/protocol/headers";
import postgres, { type Sql } from "postgres";
import { createBetterAuth } from "../auth/betterauth";
import { seedUserSpace } from "../test-support";
import { authenticateUser } from "./authenticate-user";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const rand = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += a[b % 36];
  return s;
};
const email = () => `u_${crypto.randomUUID().slice(0, 8)}@example.com`;
const ALLOWED = ["https://test.example.com"];

let sql: Sql;
let authSchema: string;
let coreSchema: string;
let betterAuth: ReturnType<typeof createBetterAuth>;
let core: engineCore.CoreStore;
const createdSpaceSchemas: string[] = [];

/** Authenticate a request bearing `token` (+ optional X-Me-As-Agent header). */
function auth(token: string | undefined, asAgent?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (asAgent) headers[AS_AGENT_HEADER] = asAgent;
  const request = new Request("http://localhost/api/v1/user/rpc", {
    method: "POST",
    headers,
  });
  return authenticateUser(
    request,
    betterAuth.auth,
    betterAuth.verifyOAuthAccessToken,
    betterAuth.getUserEmailVerified,
    core,
    ALLOWED,
  );
}

/** Mint a real OAuth access token for `userId` (hashed row + raw bearer). */
async function mintAccessToken(userId: string): Promise<string> {
  const raw = `me_at_${rand()}${rand()}`;
  await sql.unsafe(
    `insert into ${authSchema}.oauth_access_token
       (token, client_id, user_id, scopes, expires_at)
     values ($1, 'me-cli', $2, '["openid"]'::jsonb, now() + interval '1 hour')`,
    [createHash("sha256").update(raw).digest("hex"), userId],
  );
  return raw;
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  authSchema = `auth_test_${rand()}`;
  coreSchema = `core_test_${rand()}`;
  await bootstrapSpaceDatabase(sql);
  await migrateAuth(sql, { schema: authSchema });
  await migrateCore(sql, { schema: coreSchema });
  core = engineCore.coreStore(sql, coreSchema);
  betterAuth = createBetterAuth({
    databaseUrl: URL,
    authSchema,
    baseURL: "http://localhost:3000",
    secret: "test-secret-betterauth-0123456789",
    trustedOrigins: ALLOWED,
  });
});

afterAll(async () => {
  for (const s of createdSpaceSchemas) {
    await sql.unsafe(`drop schema if exists ${s} cascade`);
  }
  await sql.unsafe(`drop schema if exists ${authSchema} cascade`);
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await betterAuth.pool.end();
  await sql.end();
});

async function seedUser(): Promise<string> {
  // auth: insert the users row too — the OAuth path joins it.
  const r = await seedUserSpace(
    sql,
    { core: coreSchema, auth: authSchema },
    { email: email() },
  );
  createdSpaceSchemas.push(`me_${r.spaceSlug}`);
  return r.userId;
}

test("OAuth access token authenticates as the user (not viaApiKey)", async () => {
  const userId = await seedUser();
  const result = await auth(await mintAccessToken(userId));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.userId).toBe(userId);
    expect(result.context.viaApiKey).toBe(false);
  }
});

test("the user's own api key (PAT) authenticates as the user (viaApiKey), carrying the real emailVerified", async () => {
  const userId = await seedUser(); // seedUserSpace sets email_verified = true
  const key = await core.createApiKey(userId, "pat");
  const result = await auth(engineCore.formatApiKey(key.lookupId, key.secret));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.userId).toBe(userId);
    expect(result.context.viaApiKey).toBe(true);
    // Not a sentinel: the PAT path reads the real users.email_verified, so a
    // PAT behaves like a session (incl. the email-keyed redemption step).
    expect(result.context.emailVerified).toBe(true);
  }
});

test("a PAT for an unverified user reports emailVerified=false (read from the DB, not faked)", async () => {
  const userId = await seedUser();
  await sql.unsafe(
    `update ${authSchema}.users set email_verified = false where id = $1`,
    [userId],
  );
  const key = await core.createApiKey(userId, "pat");
  const result = await auth(engineCore.formatApiKey(key.lookupId, key.secret));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.context.emailVerified).toBe(false);
});

test("an agent api key is admitted on the user RPC as kind 'a' (no email)", async () => {
  // Authn establishes *who*; it no longer doubles as the authz gate. An agent
  // key validates to its agent principal so the account-scoped reads (whoami,
  // space.list) work; the per-method handlers still deny account management.
  const userId = await seedUser();
  const agentId = await core.createAgent(userId, `agent-${rand()}`);
  const key = await core.createApiKey(agentId, "ci");
  const result = await auth(engineCore.formatApiKey(key.lookupId, key.secret));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.kind).toBe("a");
    expect(result.context.userId).toBe(agentId);
    expect(result.context.viaApiKey).toBe(true);
    expect(result.context.email).toBeNull();
    expect(result.context.emailVerified).toBe(false);
  }
});

// =============================================================================
// Act-as-agent (X-Me-As-Agent)
// =============================================================================

test("act-as: human OAuth + owned agent by id → kind='a', userId=agent, email null, viaApiKey, authenticatedAs=human", async () => {
  const userId = await seedUser();
  const agentId = await core.createAgent(userId, `agent-${rand()}`);
  const result = await auth(await mintAccessToken(userId), agentId);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.kind).toBe("a");
    expect(result.context.userId).toBe(agentId);
    expect(result.context.email).toBeNull();
    expect(result.context.emailVerified).toBe(false);
    expect(result.context.viaApiKey).toBe(true);
    expect(result.context.authenticatedAs).toBe(userId);
  }
});

test("act-as: human OAuth + owned agent by name (mixed case) → switches to the agent", async () => {
  const userId = await seedUser();
  const name = `agent-${rand()}`;
  const agentId = await core.createAgent(userId, name);
  const result = await auth(await mintAccessToken(userId), name.toUpperCase());
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.kind).toBe("a");
    expect(result.context.userId).toBe(agentId);
    expect(result.context.authenticatedAs).toBe(userId);
  }
});

test("act-as: human OAuth + owned agent by UPPERCASE id → switches (id match is case-insensitive)", async () => {
  const userId = await seedUser();
  const agentId = await core.createAgent(userId, `agent-${rand()}`);
  // Postgres emits uuids lowercase, but a client may send an uppercase UUID.
  const result = await auth(
    await mintAccessToken(userId),
    agentId.toUpperCase(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.kind).toBe("a");
    expect(result.context.userId).toBe(agentId);
    expect(result.context.authenticatedAs).toBe(userId);
  }
});

test("act-as: id/name collision among owned agents → 403 INVALID_AGENT", async () => {
  const userId = await seedUser();
  const idAgent = await core.createAgent(userId, `agent-${rand()}`);
  await core.createAgent(userId, idAgent);

  const result = await auth(await mintAccessToken(userId), idAgent);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.status).toBe(403);
    const body = (await result.error.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("INVALID_AGENT");
    expect(body.error.message).toContain("matches multiple agents");
  }
});

test("act-as: agent-key bearer + X-Me-As-Agent → header ignored (key trumps)", async () => {
  const userId = await seedUser();
  const a = await core.createAgent(userId, `agent-${rand()}`);
  const b = await core.createAgent(userId, `agent-${rand()}`); // a valid other agent
  const key = await core.createApiKey(a, "ci");
  const result = await auth(
    engineCore.formatApiKey(key.lookupId, key.secret),
    b,
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    // Stays the key's own agent; not switched to b.
    expect(result.context.userId).toBe(a);
    expect(result.context.authenticatedAs).toBeNull();
  }
});

test("act-as: unknown / unowned header → 403 INVALID_AGENT", async () => {
  const userId = await seedUser();
  const other = await seedUser();
  const foreign = await core.createAgent(other, `agent-${rand()}`);
  for (const value of [foreign, "does-not-exist"]) {
    const result = await auth(await mintAccessToken(userId), value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(403);
      const body = (await result.error.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_AGENT");
    }
  }
});

test("act-as parity: human+X-Me-As-Agent equals the agent-key context on kind/userId", async () => {
  const userId = await seedUser();
  const agentId = await core.createAgent(userId, `agent-${rand()}`);
  const key = await core.createApiKey(agentId, "ci");

  const asAgent = await auth(await mintAccessToken(userId), agentId);
  const byKey = await auth(engineCore.formatApiKey(key.lookupId, key.secret));
  expect(asAgent.ok).toBe(true);
  expect(byKey.ok).toBe(true);
  if (asAgent.ok && byKey.ok) {
    // Authorization reads only kind + userId — identical on both paths.
    expect(asAgent.context.kind).toBe(byKey.context.kind);
    expect(asAgent.context.userId).toBe(byKey.context.userId);
    // Observability-only: authenticatedAs may differ.
    expect(asAgent.context.authenticatedAs).toBe(userId);
    expect(byKey.context.authenticatedAs).toBeNull();
  }
});

test("an invalid api key → 401", async () => {
  const result = await auth(`me.${"a".repeat(16)}.${"s".repeat(32)}`);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(401);
});

test("a bogus (non-key, non-token) bearer → 401", async () => {
  const result = await auth("not-a-real-credential");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(401);
});

test("missing credential → 401", async () => {
  const result = await auth(undefined);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(401);
});

// The login gate: better-auth's `session.create.before` hook refuses to create a
// session for an unverified email. Social sign-in (and the CLI's OAuth flow,
// which rides the web session) goes through `internalAdapter.createSession`, so
// we exercise the gate directly through it rather than mocking a whole provider.
describe("login gate (a verified email is required to establish a session)", () => {
  async function createSession(userId: string) {
    const ctx = await betterAuth.auth.$context;
    return ctx.internalAdapter.createSession(userId, false);
  }

  test("an unverified user cannot get a session (no row written)", async () => {
    const userId = await seedUser();
    await sql.unsafe(
      `update ${authSchema}.users set email_verified = false where id = $1`,
      [userId],
    );
    let error: unknown;
    try {
      await createSession(userId);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    const [row] = await sql.unsafe(
      `select count(*)::int as n from ${authSchema}.sessions where user_id = $1`,
      [userId],
    );
    expect(row?.n).toBe(0);
  });

  test("a verified user gets a session", async () => {
    const userId = await seedUser(); // seedUserSpace sets email_verified = true
    const session = await createSession(userId);
    expect(session).toBeTruthy();
    const [row] = await sql.unsafe(
      `select count(*)::int as n from ${authSchema}.sessions where user_id = $1`,
      [userId],
    );
    expect(row?.n).toBe(1);
  });
});
