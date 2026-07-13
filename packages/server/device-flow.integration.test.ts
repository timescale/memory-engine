// End-to-end integration test for the device authorization grant (RFC 8628).
//
// Drives the full better-auth device flow through the real auth handler — code
// request → claim → approve/deny → token — then asserts the minted session token
// authenticates on BOTH resource-server endpoints (user + space) via the bearer
// plugin. This is the whole point of the feature: a headless CLI logs in and its
// session token works as an API bearer.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/device-flow.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import * as engineCore from "@memory.build/engine/core";
import { SPACE_HEADER } from "@memory.build/protocol/headers";
import postgres, { type Sql } from "postgres";
import { createBetterAuth } from "./auth/betterauth";
import { authenticateSpace } from "./middleware/authenticate-space";
import { authenticateUser } from "./middleware/authenticate-user";
import { seedUserSpace } from "./test-support";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";
const BASE = "http://localhost:3000";
const AUTH = "/api/v1/auth";
const ALLOWED = ["https://test.example.com"];
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const rand = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += a[b % 36];
  return s;
};

let sql: Sql;
let authSchema: string;
let coreSchema: string;
let betterAuth: ReturnType<typeof createBetterAuth>;
let core: engineCore.CoreStore;
const createdSpaceSchemas: string[] = [];

/** Call a better-auth endpoint through the real handler. */
async function authFetch(
  path: string,
  opts: { method: string; body?: unknown; token?: string } = { method: "GET" },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const req = new Request(`${BASE}${AUTH}${path}`, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await betterAuth.auth.handler(req);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** A verified user's session token (drives the browser-approval side). */
async function sessionTokenFor(userId: string): Promise<string> {
  const ctx = await betterAuth.auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false);
  if (!session?.token) throw new Error("failed to create session");
  return session.token;
}

async function seedUser(): Promise<{ userId: string; spaceSlug: string }> {
  const r = await seedUserSpace(
    sql,
    { core: coreSchema, auth: authSchema },
    { email: `u_${crypto.randomUUID().slice(0, 8)}@example.com` },
  );
  createdSpaceSchemas.push(`me_${r.spaceSlug}`);
  return { userId: r.userId, spaceSlug: r.spaceSlug };
}

/** Request a device code (as the CLI would). */
async function requestDeviceCode(): Promise<{
  deviceCode: string;
  userCode: string;
}> {
  const { status, json } = await authFetch("/device/code", {
    method: "POST",
    body: { client_id: "me-cli" },
  });
  expect(status).toBe(200);
  return {
    deviceCode: json.device_code as string,
    userCode: json.user_code as string,
  };
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
    baseURL: BASE,
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

describe("device authorization grant", () => {
  test("code request returns a device + user code and verification URL", async () => {
    const { status, json } = await authFetch("/device/code", {
      method: "POST",
      body: { client_id: "me-cli" },
    });
    expect(status).toBe(200);
    expect(typeof json.device_code).toBe("string");
    expect(typeof json.user_code).toBe("string");
    // verificationUri points at the web page (baseURL + /device).
    expect(json.verification_uri).toBe(`${BASE}/device`);
    expect(json.interval).toBeGreaterThan(0);
  });

  test("code request from a non-me-cli client is rejected", async () => {
    const { status, json } = await authFetch("/device/code", {
      method: "POST",
      body: { client_id: "some-other-client" },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client");
  });

  test("polling before approval returns authorization_pending", async () => {
    const { deviceCode } = await requestDeviceCode();
    const { status, json } = await authFetch("/device/token", {
      method: "POST",
      body: {
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: "me-cli",
      },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("authorization_pending");
  });

  test("approve → token mints a session that authenticates on both RPCs", async () => {
    const { userId, spaceSlug } = await seedUser();
    const token = await sessionTokenFor(userId);
    const { deviceCode, userCode } = await requestDeviceCode();

    // Browser side: claim the code to this user, then approve it.
    const claim = await authFetch(
      `/device?user_code=${encodeURIComponent(userCode)}`,
      { method: "GET", token },
    );
    expect(claim.status).toBe(200);
    expect(claim.json.status).toBe("pending");

    const approve = await authFetch("/device/approve", {
      method: "POST",
      body: { userCode },
      token,
    });
    expect(approve.status).toBe(200);
    expect(approve.json.success).toBe(true);

    // CLI side: poll succeeds and returns the session token.
    const tok = await authFetch("/device/token", {
      method: "POST",
      body: {
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: "me-cli",
      },
    });
    expect(tok.status).toBe(200);
    const accessToken = tok.json.access_token as string;
    expect(typeof accessToken).toBe("string");

    // The minted session token authenticates on the user RPC as the user.
    const userReq = new Request(`${BASE}/api/v1/user/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userResult = await authenticateUser(
      userReq,
      betterAuth.auth,
      betterAuth.verifyOAuthAccessToken,
      betterAuth.getUserEmailVerified,
      core,
      ALLOWED,
    );
    expect(userResult.ok).toBe(true);
    if (userResult.ok) {
      expect(userResult.context.userId).toBe(userId);
      expect(userResult.context.kind).toBe("u");
      expect(userResult.context.viaApiKey).toBe(false);
    }

    // …and on the space RPC (bearer, non-ambient → no CSRF gate).
    const spaceReq = new Request(`${BASE}/api/v1/memory/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        [SPACE_HEADER]: spaceSlug,
      },
    });
    const spaceResult = await authenticateSpace(spaceReq, {
      core,
      betterAuth: betterAuth.auth,
      verifyOAuthToken: betterAuth.verifyOAuthAccessToken,
      db: sql,
      allowedOrigins: ALLOWED,
    });
    expect(spaceResult.ok).toBe(true);
    if (spaceResult.ok) {
      expect(spaceResult.context.principalId).toBe(userId);
      expect(spaceResult.context.principalKind).toBe("u");
    }
  });

  test("token is single-use (consumed on first success)", async () => {
    const { userId } = await seedUser();
    const token = await sessionTokenFor(userId);
    const { deviceCode, userCode } = await requestDeviceCode();

    await authFetch(`/device?user_code=${encodeURIComponent(userCode)}`, {
      method: "GET",
      token,
    });
    await authFetch("/device/approve", {
      method: "POST",
      body: { userCode },
      token,
    });
    const first = await authFetch("/device/token", {
      method: "POST",
      body: {
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: "me-cli",
      },
    });
    expect(first.status).toBe(200);

    // A second exchange of the same device code fails (the row was consumed).
    const second = await authFetch("/device/token", {
      method: "POST",
      body: {
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: "me-cli",
      },
    });
    expect(second.status).toBe(400);
  });

  test("deny → token returns access_denied", async () => {
    const { userId } = await seedUser();
    const token = await sessionTokenFor(userId);
    const { deviceCode, userCode } = await requestDeviceCode();

    await authFetch(`/device?user_code=${encodeURIComponent(userCode)}`, {
      method: "GET",
      token,
    });
    const deny = await authFetch("/device/deny", {
      method: "POST",
      body: { userCode },
      token,
    });
    expect(deny.status).toBe(200);

    const tok = await authFetch("/device/token", {
      method: "POST",
      body: {
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: "me-cli",
      },
    });
    expect(tok.status).toBe(400);
    expect(tok.json.error).toBe("access_denied");
  });

  test("a user cannot approve a code claimed by another user", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const ownerToken = await sessionTokenFor(owner.userId);
    const strangerToken = await sessionTokenFor(stranger.userId);
    const { userCode } = await requestDeviceCode();

    // Owner claims the code.
    await authFetch(`/device?user_code=${encodeURIComponent(userCode)}`, {
      method: "GET",
      token: ownerToken,
    });
    // Stranger tries to approve it → rejected.
    const approve = await authFetch("/device/approve", {
      method: "POST",
      body: { userCode },
      token: strangerToken,
    });
    expect(approve.status).toBeGreaterThanOrEqual(400);
    expect(approve.json.success).toBeUndefined();
  });
});
