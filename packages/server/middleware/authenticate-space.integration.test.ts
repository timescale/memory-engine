// Integration test for space authentication (authenticateSpace).
//
// Stands up auth + core schemas and the space DB in one database, provisions a
// user (auth identity + core principal + space + owner grant), then exercises
// the session and api-key credential modes plus the failure paths.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/middleware/authenticate-space.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  bootstrapSpaceDatabase,
  generateSlug,
  migrateAuth,
  migrateCore,
  provisionSpace,
} from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import postgres, { type Sql } from "postgres";
import { createBetterAuth } from "../auth/betterauth";
import { addSpaceCreator, provisionUser } from "../provision";
import { authenticateSpace, SPACE_HEADER } from "./authenticate-space";

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
const email = () => `space_${crypto.randomUUID().slice(0, 8)}@example.com`;

let sql: Sql;
let authSchema: string;
let coreSchema: string;
let betterAuth: ReturnType<typeof createBetterAuth>;
const createdSpaceSchemas: string[] = [];

// The deps authenticateSpace needs; bound to the test schemas.
function deps() {
  return {
    core: engineCore.coreStore(sql, coreSchema),
    betterAuth: betterAuth.auth,
    verifyOAuthToken: betterAuth.verifyOAuthAccessToken,
    db: sql,
    allowedOrigins: ["https://test.example.com"],
  };
}

/** Build a request with optional bearer token + X-Me-Space header. */
function req(opts: { token?: string; space?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.space) headers[SPACE_HEADER] = opts.space;
  return new Request("http://localhost/api/v1/memory/rpc", {
    method: "POST",
    headers,
  });
}

/**
 * Mint a real OAuth access token for `userId`: store sha256(raw) in
 * oauth_access_token (exactly what verifyOAuthAccessToken hashes + looks up) and
 * return the raw bearer. Bound to the seeded `me-cli` client; valid for 1h.
 */
async function mintAccessToken(userId: string): Promise<string> {
  const raw = `me_at_${rand()}${rand()}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  await sql.unsafe(
    `insert into ${authSchema}.oauth_access_token
       (token, client_id, user_id, scopes, expires_at)
     values ($1, 'me-cli', $2, '["openid"]'::jsonb, now() + interval '1 hour')`,
    [hash, userId],
  );
  return raw;
}

// Provision a user + space and return its slug, the user id, and a bearer (a
// real OAuth access token — the human credential under the new model).
async function provision() {
  const r = await provisionUser(
    sql,
    { auth: authSchema, core: coreSchema },
    {
      email: email(),
      name: "Tester",
      provider: "github",
      accountId: crypto.randomUUID(),
    },
  );
  createdSpaceSchemas.push(`me_${r.spaceSlug}`);
  const token = await mintAccessToken(r.userId);
  return { ...r, token };
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  authSchema = `auth_test_${rand()}`;
  coreSchema = `core_test_${rand()}`;
  await bootstrapSpaceDatabase(sql);
  await migrateAuth(sql, { schema: authSchema });
  await migrateCore(sql, { schema: coreSchema });
  betterAuth = createBetterAuth({
    databaseUrl: URL,
    authSchema,
    baseURL: "http://localhost:3000",
    secret: "test-secret-betterauth-0123456789",
    trustedOrigins: ["https://test.example.com"],
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

test("session: member with owner grant resolves space + treeAccess", async () => {
  const p = await provision();
  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.space.id).toBe(p.spaceId);
    expect(result.context.principalId).toBe(p.userId);
    expect(result.context.apiKeyId).toBeNull();
    // the creator owns the shared root (and its own home), not owner@root
    expect(result.context.treeAccess).toContainEqual({
      tree_path: "share",
      access: engineCore.ACCESS.owner,
    });
  }
});

test("api key: agent of the space resolves with apiKeyId set", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);

  const agentId = await core.createAgent(p.userId, `agent-${rand()}`);
  await core.addPrincipalToSpace(p.spaceId, agentId);
  // grant within the owner's access (it owns `share`) so the agent's clamped
  // effective access is non-empty — the owner is no longer owner@root.
  await core.grantTreeAccess(
    p.spaceId,
    agentId,
    "share",
    engineCore.ACCESS.read,
  );
  const key = await core.createApiKey(agentId, "ci");
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);

  const result = await authenticateSpace(
    req({ token: fullKey, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(agentId);
    expect(result.context.apiKeyId).not.toBeNull();
    expect(result.context.treeAccess.length).toBeGreaterThan(0);
  }
});

test("api key is global: one key authenticates into every space the agent belongs to", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);

  // A second space also created by p, so p (the agent's owner) has access in
  // both — the agent's effective access is clamped to its owner's.
  const slug2 = generateSlug();
  const spaceId2 = await core.createSpace(slug2, "second");
  await provisionSpace(sql, { slug: slug2 });
  createdSpaceSchemas.push(`me_${slug2}`);
  await addSpaceCreator(core, spaceId2, p.userId);

  const agentId = await core.createAgent(p.userId, `agent-${rand()}`);
  for (const sid of [p.spaceId, spaceId2]) {
    await core.addPrincipalToSpace(sid, agentId);
    await core.grantTreeAccess(sid, agentId, "share", engineCore.ACCESS.read);
  }
  const key = await core.createApiKey(agentId, "ci");
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);

  for (const slug of [p.spaceSlug, slug2]) {
    const result = await authenticateSpace(
      req({ token: fullKey, space: slug }),
      deps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.principalId).toBe(agentId);
  }
});

test("legacy 4-part api key → 401 with a LEGACY_API_KEY recreate message", async () => {
  const p = await provision();
  // A token shaped like the retired me.<slug>.<lookup>.<secret> format.
  const legacy = `me.${p.spaceSlug}.${"a".repeat(16)}.${"s".repeat(32)}`;
  const result = await authenticateSpace(
    req({ token: legacy, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.status).toBe(401);
    const body = (await result.error.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("LEGACY_API_KEY");
    expect(body.error.message).toContain("me apikey create");
  }
});

test("missing Authorization → 401", async () => {
  const result = await authenticateSpace(
    req({ space: "abcdef012345" }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(401);
});

test("missing X-Me-Space → 400", async () => {
  const p = await provision();
  const result = await authenticateSpace(req({ token: p.token }), deps());
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(400);
});

test("unknown space → 401", async () => {
  const p = await provision();
  const result = await authenticateSpace(
    req({ token: p.token, space: "zzzzzz999999" }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(401);
});

test("invalid session token → 401", async () => {
  const p = await provision();
  const result = await authenticateSpace(
    req({ token: "not-a-real-session-token", space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(401);
});

test("api key: agent with no access in the requested space → 403", async () => {
  const p = await provision();
  const other = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const agentId = await core.createAgent(p.userId, `agent-${rand()}`);
  await core.addPrincipalToSpace(p.spaceId, agentId);
  await core.grantTreeAccess(
    p.spaceId,
    agentId,
    "share",
    engineCore.ACCESS.read,
  );
  const key = await core.createApiKey(agentId, "ci");
  // A valid global key, but the agent has no access in `other` — the access gate
  // (build_tree_access empty) denies it rather than a parse-time rejection.
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);
  const result = await authenticateSpace(
    req({ token: fullKey, space: other.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
});

test("session: member of another space has no grant here → 403", async () => {
  const a = await provision();
  const b = await provision();
  // b's session against a's space — b has no grant in a's space.
  const result = await authenticateSpace(
    req({ token: b.token, space: a.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
});
