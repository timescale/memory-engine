// Integration test for user-RPC authentication (authenticateUser).
//
// Covers the three admitted credentials + the bars: an OAuth access token and
// the user's OWN api key (a PAT) authenticate as the user; an AGENT api key is
// rejected here (agents can't manage the account); invalid/missing → 401.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/middleware/authenticate-user.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
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

/** Authenticate a request bearing `token` (helper around authenticateUser). */
function auth(token: string | undefined) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = new Request("http://localhost/api/v1/user/rpc", {
    method: "POST",
    headers,
  });
  return authenticateUser(
    request,
    betterAuth.auth,
    betterAuth.verifyOAuthAccessToken,
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

test("the user's own api key (PAT) authenticates as the user (viaApiKey)", async () => {
  const userId = await seedUser();
  const key = await core.createApiKey(userId, "pat");
  const result = await auth(engineCore.formatApiKey(key.lookupId, key.secret));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.userId).toBe(userId);
    expect(result.context.viaApiKey).toBe(true);
  }
});

test("an agent api key is forbidden on the user RPC (403)", async () => {
  const userId = await seedUser();
  const agentId = await core.createAgent(userId, `agent-${rand()}`);
  const key = await core.createApiKey(agentId, "ci");
  const result = await auth(engineCore.formatApiKey(key.lookupId, key.secret));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
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
