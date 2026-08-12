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
const today = () => new Date().toISOString().slice(0, 10);

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

/** Build a request with optional bearer token + X-Me-Space / legacy ignored header. */
function req(opts: {
  token?: string;
  space?: string;
  asAgent?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.space) headers[SPACE_HEADER] = opts.space;
  if (opts.asAgent) headers["X-Me-As-Agent"] = opts.asAgent;
  return new Request("http://localhost/api/v1/memory/rpc", {
    method: "POST",
    headers,
  });
}

async function restrictApiKey(
  keyId: string,
  spaceId: string,
  grants: [string, number][] = [],
  spaceAdmin = false,
) {
  await sql.unsafe(
    `update ${coreSchema}.api_key set restricted = true where id = $1`,
    [keyId],
  );
  await sql.unsafe(
    `insert into ${coreSchema}.api_key_space_access (api_key_id, space_id, space_admin)
     values ($1, $2, $3)`,
    [keyId, spaceId, spaceAdmin],
  );
  for (const [treePath, access] of grants) {
    await sql.unsafe(
      `insert into ${coreSchema}.api_key_tree_access (api_key_id, space_id, tree_path, access)
       values ($1, $2, $3::ltree, $4)`,
      [keyId, spaceId, treePath, access],
    );
  }
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
    const principal = await engineCore
      .coreStore(sql, coreSchema)
      .getPrincipal(p.userId);
    if (!principal) throw new Error("seeded principal not found");
    expect(result.context.space.id).toBe(p.spaceId);
    expect(result.context.principalId).toBe(p.userId);
    expect(result.context.principalName).toBe(principal.name);
    expect(result.context.apiKeyId).toBeNull();
    expect(result.context.apiKeyName).toBeNull();
    // the creator owns the shared root (and its own home), not owner@root
    expect(result.context.treeAccess).toContainEqual({
      tree_path: "share",
      access: engineCore.ACCESS.owner,
    });
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
    const principal = await core.getPrincipal(p.userId);
    if (!principal) throw new Error("seeded principal not found");
    // Authenticates as the user with full grants.
    expect(result.context.principalId).toBe(p.userId);
    expect(result.context.principalName).toBe(principal.name);
    expect(result.context.apiKeyId).not.toBeNull();
    expect(result.context.apiKeyName).toBe("my-pat");
    expect(result.context.treeAccess).toContainEqual({
      tree_path: "share",
      access: engineCore.ACCESS.owner,
    });
  }
});

test("restricted PAT is limited to its declared space and tree grants", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const key = await core.createApiKey(p.userId, "scoped-pat");
  await restrictApiKey(key.id, p.spaceId, [
    ["share.project", engineCore.ACCESS.write],
  ]);
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);

  const allowed = await authenticateSpace(
    req({ token: fullKey, space: p.spaceSlug }),
    deps(),
  );
  expect(allowed.ok).toBe(true);
  if (allowed.ok) {
    expect(allowed.context.admin).toBe(false);
    expect(allowed.context.treeAccess).toEqual([
      { tree_path: "share.project", access: engineCore.ACCESS.write },
    ]);
  }

  const slug2 = generateSlug();
  const spaceId2 = await core.createSpace(slug2, "undeclared");
  await provisionSpace(sql, { slug: slug2 });
  createdSpaceSchemas.push(`me_${slug2}`);
  await addSpaceCreator(core, spaceId2, p.userId);

  const denied = await authenticateSpace(
    req({ token: fullKey, space: slug2 }),
    deps(),
  );
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error.status).toBe(403);
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
    expect(result.context.apiKeyId).not.toBeNull();
    expect(result.context.treeAccess).toContainEqual({
      tree_path: "share.deploy",
      access: engineCore.ACCESS.write,
    });
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

test("api key: service account that is not a member of the requested space → 403", async () => {
  const p = await provision();
  const other = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const serviceAccount = await core.createServiceAccount(
    p.spaceId,
    `svc-${rand()}`,
  );
  const key = await core.createApiKey(serviceAccount.id, "ci");
  // A valid key, but the service account has no principal_space membership in
  // `other` — the membership gate denies it rather than a parse-time rejection.
  const fullKey = engineCore.formatApiKey(key.lookupId, key.secret);
  const result = await authenticateSpace(
    req({ token: fullKey, space: other.spaceSlug }),
    deps(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
  expect((await core.getApiKey(key.id))?.lastUsedOn).toBe(today());
});

test("api key: invalid secret does not record usage", async () => {
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const key = await core.createApiKey(p.userId, "bad-secret-test");
  const invalid = engineCore.formatApiKey(key.lookupId, "s".repeat(32));

  const result = await authenticateSpace(
    req({ token: invalid, space: p.spaceSlug }),
    deps(),
  );

  expect(result.ok).toBe(false);
  expect((await core.getApiKey(key.id))?.lastUsedOn).toBeNull();
});

test("session: authenticating with a session does not touch the user's api keys", async () => {
  // Same user has both a valid session (via provision) and an unrelated PAT.
  // A session auth must not touch the PAT's last_used_on — usage recording is
  // scoped to the credential that was actually presented.
  const p = await provision();
  const core = engineCore.coreStore(sql, coreSchema);
  const key = await core.createApiKey(p.userId, `session-noop-${rand()}`);

  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug }),
    deps(),
  );

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.context.apiKeyId).toBeNull();
  expect((await core.getApiKey(key.id))?.lastUsedOn).toBeNull();
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

test("legacy X-Me-As-Agent is ignored", async () => {
  const p = await provision();
  const result = await authenticateSpace(
    req({ token: p.token, space: p.spaceSlug, asAgent: "retired-agent" }),
    deps(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.context.principalId).toBe(p.userId);
});
