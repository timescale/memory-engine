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
import { AS_AGENT_HEADER } from "@memory.build/protocol/headers";
import postgres, { type Sql } from "postgres";
import { createBetterAuth } from "../auth/betterauth";
import { addSpaceCreator } from "../provision";
import { memoryMethods } from "../rpc/memory";
import { seedUserSpace } from "../test-support";
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

/** Build a request with optional bearer token + X-Me-Space / X-Me-As-Agent. */
function req(opts: {
  token?: string;
  space?: string;
  asAgent?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.space) headers[SPACE_HEADER] = opts.space;
  if (opts.asAgent) headers[AS_AGENT_HEADER] = opts.asAgent;
  return new Request("http://localhost/api/v1/memory/rpc", {
    method: "POST",
    headers,
  });
}

/**
 * Provision `p`'s owned agent as a space member with a `read@share` grant (clamped
 * to the owner's `owner@share`) and an api key. Returns the agent + full key so
 * the act-as (human header) and agent-key paths can be compared for parity.
 */
async function seedOwnedAgent(p: Awaited<ReturnType<typeof provision>>) {
  const core = engineCore.coreStore(sql, coreSchema);
  const name = `agent-${rand()}`;
  const agentId = await core.createAgent(p.userId, name);
  await core.addPrincipalToSpace(p.spaceId, agentId);
  await core.grantTreeAccess(
    p.spaceId,
    agentId,
    "share",
    engineCore.ACCESS.read,
  );
  const key = await core.createApiKey(agentId, "ci");
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);
  return { agentId, name, fullKey };
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

async function createAuthUser(emailAddress = email()): Promise<string> {
  const [row] = await sql`select uuidv7() as id`;
  const userId = row?.id as string;
  await sql.unsafe(
    `insert into ${authSchema}.users (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [userId, "Tester", emailAddress],
  );
  await engineCore.coreStore(sql, coreSchema).createUser(userId, emailAddress);
  return userId;
}

async function removeHomeGrant(spaceId: string, principalId: string) {
  await engineCore
    .coreStore(sql, coreSchema)
    .removeTreeAccessGrant(
      spaceId,
      principalId,
      `home.${principalId.replaceAll("-", "")}`,
    );
}

// Provision a user + space and return its slug, the user id, and a bearer (a
// real OAuth access token — the human credential under the new model).
async function provision() {
  // auth: also insert the better-auth users row — mintAccessToken's token joins
  // users in verifyOAuthAccessToken.
  const r = await seedUserSpace(
    sql,
    { core: coreSchema, auth: authSchema },
    { email: email(), name: "Tester" },
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

test("api key: a user's own key (PAT) resolves as the user with full grants", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);

  // A personal access token minted for the user's own principal.
  const key = await core.createApiKey(p.userId, "my-pat");
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);

  const result = await authenticateSpace(
    req({ token: fullKey, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    // Authenticates as the user (not clamped like an agent) with full grants.
    expect(result.context.principalId).toBe(p.userId);
    expect(result.context.apiKeyId).not.toBeNull();
    expect(result.context.treeAccess).toContainEqual({
      tree_path: "share",
      access: engineCore.ACCESS.owner,
    });
  }
});

test("session: direct member with zero tree grants authenticates", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const memberId = await createAuthUser();
  await core.addPrincipalToSpace(p.spaceId, memberId);
  await removeHomeGrant(p.spaceId, memberId);
  expect(await core.buildTreeAccess(memberId, p.spaceId)).toEqual([]);
  const token = await mintAccessToken(memberId);

  const result = await authenticateSpace(
    req({ token, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(memberId);
    expect(result.context.admin).toBe(false);
    expect(result.context.treeAccess).toEqual([]);
  }
});

test("session: last admin with zero tree grants can still authenticate and manage structure", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  await core.removeTreeAccessGrant(p.spaceId, p.userId, "share");
  await removeHomeGrant(p.spaceId, p.userId);
  expect(await core.buildTreeAccess(p.userId, p.spaceId)).toEqual([]);

  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.admin).toBe(true);
    expect(result.context.treeAccess).toEqual([]);
    const registered = memoryMethods.get("principal.list");
    if (!registered) throw new Error("principal.list not registered");
    const listed = (await registered.handler(
      {},
      {
        request: new Request("http://localhost/api/v1/memory/rpc"),
        ...result.context,
      },
    )) as { principals: { id: string }[] };
    expect(listed.principals.some((m) => m.id === p.userId)).toBe(true);
  }
});

test("api key: service account with zero tree grants authenticates", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const serviceAccount = await core.createServiceAccount(
    p.spaceId,
    `svc-${rand()}`,
  );
  expect(await core.buildTreeAccess(serviceAccount.id, p.spaceId)).toEqual([]);
  const key = await core.createApiKey(serviceAccount.id, "ci");
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);

  const result = await authenticateSpace(
    req({ token: fullKey, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(serviceAccount.id);
    expect(result.context.principalKind).toBe("s");
    expect(result.context.admin).toBe(false);
    expect(result.context.apiKeyId).not.toBeNull();
    expect(result.context.treeAccess).toEqual([]);
  }
});

test("api key: service account resolves with direct tree access and no owner", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const serviceAccount = await core.createServiceAccount(
    p.spaceId,
    `svc-${rand()}`,
  );
  await core.grantTreeAccess(
    p.spaceId,
    serviceAccount.id,
    "share.deploy",
    engineCore.ACCESS.write,
  );
  const key = await core.createApiKey(serviceAccount.id, "ci");
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);

  const result = await authenticateSpace(
    req({ token: fullKey, space: p.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(serviceAccount.id);
    expect(result.context.principalKind).toBe("s");
    expect(result.context.ownerId).toBeNull();
    expect(result.context.apiKeyId).not.toBeNull();
    expect(result.context.treeAccess).toContainEqual({
      tree_path: "share.deploy",
      access: engineCore.ACCESS.write,
    });
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

test("api key: agent that is not a member of the requested space → 403", async () => {
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
  // A valid global key, but the agent has no principal_space membership in
  // `other` — the membership gate denies it rather than a parse-time rejection.
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);
  const result = await authenticateSpace(
    req({ token: fullKey, space: other.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
});

test("session: member of another space is not a member here → 403", async () => {
  const a = await provision();
  const b = await provision();
  // b's session against a's space — b has no membership in a's space.
  const result = await authenticateSpace(
    req({ token: b.token, space: a.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
});

// =============================================================================
// Act-as-agent (X-Me-As-Agent)
// =============================================================================

test("act-as: human session + owned agent by id → principal switch, ownerId=human, clamped access, admin=false", async () => {
  const p = await provision();
  const { agentId } = await seedOwnedAgent(p);

  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug, asAgent: agentId }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(agentId);
    expect(result.context.ownerId).toBe(p.userId);
    expect(result.context.authenticatedAs).toBe(p.userId);
    expect(result.context.admin).toBe(false);
    // Clamped to the agent's grant (least(read, owner@share) = read), not the
    // human's owner@share.
    expect(result.context.treeAccess).toContainEqual({
      tree_path: "share",
      access: engineCore.ACCESS.read,
    });
    expect(result.context.treeAccess).not.toContainEqual({
      tree_path: "share",
      access: engineCore.ACCESS.owner,
    });
  }
});

test("act-as: human session + owned agent by name (mixed case) → principal switch", async () => {
  const p = await provision();
  const { agentId, name } = await seedOwnedAgent(p);

  const mixed = name.toUpperCase();
  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug, asAgent: mixed }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(agentId);
    expect(result.context.authenticatedAs).toBe(p.userId);
  }
});

test("act-as: human session + owned agent by UPPERCASE id → principal switch (id match is case-insensitive)", async () => {
  const p = await provision();
  const { agentId } = await seedOwnedAgent(p);

  // Postgres emits uuids lowercase, but a client may send an uppercase UUID
  // (the CLI's UUID gate is case-insensitive and passes it through verbatim).
  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug, asAgent: agentId.toUpperCase() }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(agentId);
    expect(result.context.authenticatedAs).toBe(p.userId);
  }
});

test("act-as: id/name collision among owned agents → 403 INVALID_AGENT", async () => {
  const p = await provision();
  const { agentId } = await seedOwnedAgent(p);
  const core = engineCore.coreStore(sql, coreSchema);
  await core.createAgent(p.userId, agentId);

  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug, asAgent: agentId }),
    deps(),
  );
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

test("act-as: agent-key bearer + X-Me-As-Agent (a valid other owned agent) → header ignored, key trumps", async () => {
  const p = await provision();
  const a = await seedOwnedAgent(p);
  const b = await seedOwnedAgent(p); // a valid, other owned agent

  // Bearer is a's key; header names b. The key already IS an agent → ignored.
  const result = await authenticateSpace(
    req({ token: a.fullKey, space: p.spaceSlug, asAgent: b.agentId }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.principalId).toBe(a.agentId);
    expect(result.context.apiKeyId).not.toBeNull();
    expect(result.context.authenticatedAs).toBeNull();
  }
});

test("act-as: unknown/unowned/non-agent header → 403 INVALID_AGENT", async () => {
  const p = await provision();
  const other = await provision();
  // An agent owned by a DIFFERENT user — not one p owns.
  const foreign = await seedOwnedAgent(other);

  for (const value of [foreign.agentId, "does-not-exist", p.userId]) {
    const result = await authenticateSpace(
      req({ token: p.token, space: p.spaceSlug, asAgent: value }),
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(403);
      const body = (await result.error.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("INVALID_AGENT");
    }
  }
});

test("act-as: owned agent that is not a member of this space → 403", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  // An owned agent that is NOT a member of the space — the membership gate denies
  // after the switch.
  const agentId = await core.createAgent(p.userId, `agent-${rand()}`);

  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug, asAgent: agentId }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
});

test("act-as parity: human+X-Me-As-Agent equals the agent-key context on the authz fields", async () => {
  const p = await provision();
  const a = await seedOwnedAgent(p);

  const asAgent = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug, asAgent: a.agentId }),
    deps(),
  );
  const byKey = await authenticateSpace(
    req({ token: a.fullKey, space: p.spaceSlug }),
    deps(),
  );
  expect(asAgent.ok).toBe(true);
  expect(byKey.ok).toBe(true);
  if (asAgent.ok && byKey.ok) {
    // Authorization reads only these fields — identical on both paths.
    expect(asAgent.context.principalId).toBe(byKey.context.principalId);
    expect(asAgent.context.ownerId).toBe(byKey.context.ownerId);
    expect(asAgent.context.treeAccess).toEqual(byKey.context.treeAccess);
    expect(asAgent.context.admin).toBe(byKey.context.admin);
    // Observability-only fields may differ (and do).
    expect(asAgent.context.apiKeyId).toBeNull();
    expect(byKey.context.apiKeyId).not.toBeNull();
    expect(asAgent.context.authenticatedAs).toBe(p.userId);
    expect(byKey.context.authenticatedAs).toBeNull();
  }
});
