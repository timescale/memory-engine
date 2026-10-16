import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateAuth } from "@memory.build/database";
import { symmetricEncrypt } from "better-auth/crypto";
import postgres, { type Sql } from "postgres";
import { randomAuthSchema } from "../../database/auth/migrate/test-utils";
import { template } from "../../database/migrate/kit";
import {
  AUTH_BASE_PATH,
  createBetterAuth,
  handleBetterAuthRequest,
  signSessionTokenForBearer,
} from "./betterauth";

// Intentionally local-only even when an operator has TEST_DATABASE_URL set.
const DB = "postgresql://postgres@127.0.0.1:5432/postgres";
const BASE = "http://localhost:3000";
const SECRET = "upgrade-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const REDIRECT = "http://127.0.0.1:49157/callback";
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const oldMigrations = [
  "001_users",
  "002_accounts",
  "003_sessions",
  "004_device_authorization",
  "005_verifications",
  "006_betterauth",
  "007_device_code",
];
let sql: Sql;
let schema: string;
let instance: ReturnType<typeof createBetterAuth>;
let githubUser: string;
let googleUser: string;
let oldSessionId: string;
let snapshot: string;
let legacyPrivateKey: string;
let legacyPublicKey: CryptoKey;

/** Reconstruct the deployed 1.6 schema, NOT a new schema with columns dropped. */
async function legacySchema(name: string) {
  const dir = new URL("../../database/auth/migrate/", import.meta.url);
  await sql.unsafe("create extension if not exists citext");
  await sql.unsafe(
    template(await Bun.file(new URL("provision.sql", dir)).text(), {
      schema: name,
    }),
  );
  for (const migration of oldMigrations) {
    await sql.unsafe(
      template(
        await Bun.file(new URL(`incremental/${migration}.sql`, dir)).text(),
        { schema: name },
      ),
    );
    await sql.unsafe(
      `insert into ${name}.migration(name, applied_at_version) values ($1, '0.0.2')`,
      [migration],
    );
  }
  await sql.unsafe(`update ${name}.version set version = '0.0.2'`);
}

async function request(
  path: string,
  body?: Record<string, string>,
  signed?: string,
) {
  const jsonBody = path.startsWith("/device/") || path === "/sign-out";
  const headers = new Headers({
    Accept: path.startsWith("/oauth2/authorize")
      ? "text/html"
      : "application/json",
  });
  if (body)
    headers.set(
      "Content-Type",
      jsonBody ? "application/json" : "application/x-www-form-urlencoded",
    );
  if (signed) headers.set("Authorization", `Bearer ${signed}`);
  return handleBetterAuthRequest(
    instance.auth,
    new Request(`${BASE}${AUTH_BASE_PATH}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body
        ? jsonBody
          ? JSON.stringify(body)
          : new URLSearchParams(body)
        : undefined,
    }),
  );
}

async function refresh(refreshToken: string, scope?: string) {
  return request("/oauth2/token", {
    grant_type: "refresh_token",
    client_id: "me-cli",
    refresh_token: refreshToken,
    ...(scope ? { scope } : {}),
  });
}

async function onlineTokens() {
  const { session, tokens } = await codeTokens();
  // Upstream permits narrowing an offline grant and rotates a new refresh row
  // without offline_access. It must not inherit the old grant's offline policy.
  const response = await refresh(tokens.refresh_token, "profile");
  expect(response.status).toBe(200);
  const narrowed = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };
  const [row] = await sql.unsafe(
    `select scopes from ${schema}.oauth_refresh_token where token = $1`,
    [hash(narrowed.refresh_token)],
  );
  expect(row?.scopes).toEqual(["profile"]);
  return { session, tokens: narrowed };
}

async function expireSession(id: string) {
  await sql.unsafe(
    `update ${schema}.sessions set expires_at = now() - interval '1 second' where id = $1`,
    [id],
  );
}

async function browserSession() {
  const ctx = await instance.auth.$context;
  const session = await ctx.internalAdapter.createSession(githubUser, false);
  return {
    ...session,
    signed: await signSessionTokenForBearer(session.token, SECRET),
  };
}

async function authorize(signed: string, extra: Record<string, string> = {}) {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: "me-cli",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "profile email offline_access",
    state: "test-state",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ...extra,
  });
  const response = await request(
    `/oauth2/authorize?${query}`,
    undefined,
    signed,
  );
  return { response, verifier };
}

async function codeTokens() {
  const session = await browserSession();
  const { response, verifier } = await authorize(session.signed);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location") ?? "");
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("test-state");
  const code = location.searchParams.get("code");
  expect(code).toBeString();
  const body = {
    grant_type: "authorization_code",
    client_id: "me-cli",
    redirect_uri: REDIRECT,
    code: code ?? "",
    code_verifier: verifier,
  };
  const result = await request("/oauth2/token", body);
  expect(result.status).toBe(200);
  expect(result.headers.get("Cache-Control")).toContain("no-store");
  const tokens = (await result.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
  };
  expect(tokens.token_type).toBe("Bearer");
  expect(tokens.access_token).toBeString();
  expect(tokens.refresh_token).toBeString();
  return { session, tokens, body };
}

beforeAll(async () => {
  sql = postgres(DB, { onnotice: () => {} });
  schema = randomAuthSchema();
  await legacySchema(schema);
  const users =
    await sql.unsafe(`insert into ${schema}.users(name, email, email_verified)
    values ('GitHub User', 'github@example.com', true), ('Google User', 'google@example.com', true) returning id`);
  githubUser = users[0]?.id as string;
  googleUser = users[1]?.id as string;
  // Same subject at different providers MUST remain different identities.
  await sql.unsafe(
    `insert into ${schema}.accounts(user_id, provider_id, account_id, access_token)
    values ($1, 'github', 'same-subject', 'github-provider-token'),
           ($2, 'google', 'same-subject', 'google-provider-token')`,
    [githubUser, googleUser],
  );
  snapshot = JSON.stringify(
    await sql.unsafe(`select * from ${schema}.accounts order by provider_id`),
  );
  const [session] = await sql.unsafe(
    `insert into ${schema}.sessions(user_id, token, expires_at)
    values ($1, 'legacy-session', now() + interval '7 days') returning id`,
    [githubUser],
  );
  oldSessionId = session?.id as string;
  await sql.unsafe(
    `insert into ${schema}.oauth_refresh_token
    (token, client_id, session_id, user_id, scopes, expires_at)
    values ($1, 'me-cli', $2, $3, '["profile","email","offline_access"]', now() + interval '30 days')`,
    [hash("legacy-refresh"), oldSessionId, githubUser],
  );
  await sql.unsafe(
    `insert into ${schema}.oauth_access_token
    (token, client_id, session_id, user_id, scopes, expires_at)
    values ($1, 'me-cli', $2, $3, '["profile","email"]', now() + interval '1 hour')`,
    [hash("legacy-access"), oldSessionId, githubUser],
  );
  await sql.unsafe(`insert into ${schema}.oauth_client
    (client_id, client_secret, name, public, type, redirect_uris, token_endpoint_auth_method)
    values ('registered-confidential', 'existing-secret-hash', 'Existing app', false, 'web', '["https://app.example/callback"]', 'client_secret_post')`);
  await sql.unsafe(
    `insert into ${schema}.oauth_consent(client_id, user_id, scopes)
    values ('me-cli', $1, '["profile","email","offline_access"]')`,
    [githubUser],
  );
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new Error("expected an Ed25519 key pair");
  legacyPublicKey = keys.publicKey;
  legacyPrivateKey = JSON.stringify(
    await symmetricEncrypt({
      key: SECRET,
      data: JSON.stringify(
        await crypto.subtle.exportKey("jwk", keys.privateKey),
      ),
    }),
  );
  await sql.unsafe(
    `insert into ${schema}.jwks(public_key, private_key) values ($1, $2)`,
    [
      JSON.stringify(await crypto.subtle.exportKey("jwk", keys.publicKey)),
      legacyPrivateKey,
    ],
  );
  await sql.unsafe(
    `insert into ${schema}.device_code
    (device_code, user_code, user_id, expires_at, status, client_id)
    values ('legacy-device', 'OLD-CODE', $1, now() + interval '10 minutes', 'approved', 'me-cli')`,
    [googleUser],
  );
  await migrateAuth(sql, { schema });
  await migrateAuth(sql, { schema });
  instance = createBetterAuth({
    databaseUrl: DB,
    authSchema: schema,
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [BASE],
  });
});

afterAll(async () => {
  await instance?.pool.end();
  if (schema) await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql?.end();
});

describe("Better Auth 1.6 → 1.7.10", () => {
  test("the installed runtime schema agrees with our DDL (only inert legacy client columns remain)", async () => {
    const ctx = await instance.auth.$context;
    for (const table of Object.values(ctx.tables)) {
      const expected = [
        "id",
        ...Object.entries(table.fields).map(
          ([key, value]) => value.fieldName ?? key,
        ),
      ].sort();
      const actual =
        await sql`select column_name from information_schema.columns
        where table_schema = ${schema} and table_name = ${table.modelName} order by column_name`;
      const names = actual.map((row) => row.column_name as string);
      expect(
        names.filter(
          (name) =>
            table.modelName !== "oauth_client" ||
            !["public", "type"].includes(name),
        ),
      ).toEqual(expected);
    }
  });

  test("Google/GitHub account identity and tokens are unchanged, and adapter lookups resolve the original users", async () => {
    expect(
      JSON.stringify(
        await sql.unsafe(
          `select * from ${schema}.accounts order by provider_id`,
        ),
      ),
    ).toBe(snapshot);
    const ctx = await instance.auth.$context;
    for (const [providerId, userId] of [
      ["github", githubUser],
      ["google", googleUser],
    ]) {
      const account = await ctx.internalAdapter.findAccountByKey({
        providerId: providerId ?? "",
        accountId: "same-subject",
      });
      expect(account?.userId).toBe(userId);
    }
    const [key] = await sql.unsafe(
      `select private_key, alg, crv from ${schema}.jwks`,
    );
    expect(key?.private_key).toBe(legacyPrivateKey);
    expect(key?.alg).toBeNull();
    expect(key?.crv).toBeNull();
  });

  test("the seeded CLI retains PKCE/loopback/consent policy and gains explicit public authentication", async () => {
    const [client] = await sql.unsafe(
      `select * from ${schema}.oauth_client where client_id = 'me-cli'`,
    );
    expect(client?.application_type).toBe("native");
    expect(client?.token_endpoint_auth_method).toBe("none");
    expect(client?.require_pkce).toBe(true);
    expect(client?.skip_consent).toBe(true);
    expect(client?.client_credentials_scopes).toEqual([]);
    expect(client?.client_discovery_id).toBeNull();
    expect(client?.redirect_uris).toEqual(["http://127.0.0.1/callback"]);
    const [consent] = await sql.unsafe(
      `select scopes, resources from ${schema}.oauth_consent`,
    );
    expect(consent?.scopes).toEqual(["profile", "email", "offline_access"]);
    expect(consent?.resources).toBeNull();
    const [registered] = await sql.unsafe(
      `select application_type, token_endpoint_auth_method, client_secret, client_credentials_scopes from ${schema}.oauth_client where client_id = 'registered-confidential'`,
    );
    expect(registered?.application_type).toBe("web");
    expect(registered?.token_endpoint_auth_method).toBe("client_secret_post");
    expect(registered?.client_secret).toBe("existing-secret-hash");
    expect(registered?.client_credentials_scopes).toEqual([]);
    const migrations = await sql.unsafe(
      `select name from ${schema}.migration order by name`,
    );
    expect(migrations.map((row) => row.name)).toEqual([
      ...oldMigrations,
      "008_betterauth_1_7",
    ]);
  });

  test("existing session and hashed access token still authenticate; a raw session bearer still cannot", async () => {
    const signed = await signSessionTokenForBearer("legacy-session", SECRET);
    expect(
      (
        await instance.auth.api.getSession({
          headers: new Headers({ Authorization: `Bearer ${signed}` }),
        })
      )?.user.id,
    ).toBe(githubUser);
    expect(
      await instance.auth.api.getSession({
        headers: new Headers({ Authorization: "Bearer legacy-session" }),
      }),
    ).toBeNull();
    expect(
      (await instance.verifyOAuthAccessToken("legacy-access"))?.userId,
    ).toBe(githubUser);
  });

  test("a legacy encrypted signing key still signs OIDC tokens without an alg/crv backfill", async () => {
    const session = await browserSession();
    const { response, verifier } = await authorize(session.signed, {
      scope: "openid profile email offline_access",
    });
    const code =
      new URL(response.headers.get("Location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const result = await request("/oauth2/token", {
      grant_type: "authorization_code",
      client_id: "me-cli",
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
    });
    expect(result.status).toBe(200);
    const tokens = (await result.json()) as { id_token: string };
    const [header, payload, signature] = tokens.id_token.split(".");
    expect(
      JSON.parse(Buffer.from(header ?? "", "base64url").toString()).alg,
    ).toBe("EdDSA");
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        legacyPublicKey,
        Buffer.from(signature ?? "", "base64url"),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  test("an old refresh token rotates successfully without widening its audience", async () => {
    const response = await request("/oauth2/token", {
      grant_type: "refresh_token",
      client_id: "me-cli",
      refresh_token: "legacy-refresh",
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(tokens.refresh_token).not.toBe("legacy-refresh");
    expect(
      (await instance.verifyOAuthAccessToken(tokens.access_token))?.userId,
    ).toBe(githubUser);
    const [row] = await sql.unsafe(
      `select revoked from ${schema}.oauth_refresh_token where token = $1`,
      [hash("legacy-refresh")],
    );
    expect(row?.revoked).not.toBeNull();
  });

  test("a pending old standalone device request still redeems as a signed session, not OAuth tokens", async () => {
    const response = await request("/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "me-cli",
      device_code: "legacy-device",
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(tokens.refresh_token).toBeUndefined();
    expect(
      (
        await instance.auth.api.getSession({
          headers: new Headers({
            Authorization: `Bearer ${tokens.access_token}`,
          }),
        })
      )?.user.id,
    ).toBe(googleUser);
  });
});

describe("OAuth CLI protocol and resource authorization", () => {
  test("authorization code + PKCE + arbitrary loopback port issues hashed opaque tokens; refresh and revoke work", async () => {
    const { tokens } = await codeTokens();
    expect(
      (await instance.verifyOAuthAccessToken(tokens.access_token))?.userId,
    ).toBe(githubUser);
    const [stored] = await sql.unsafe(
      `select token from ${schema}.oauth_access_token where token = $1`,
      [hash(tokens.access_token)],
    );
    expect(stored?.token).toBe(hash(tokens.access_token));
    const refresh = await request("/oauth2/token", {
      grant_type: "refresh_token",
      client_id: "me-cli",
      refresh_token: tokens.refresh_token,
    });
    expect(refresh.status).toBe(200);
    const rotated = (await refresh.json()) as { access_token: string };
    expect(
      (await instance.verifyOAuthAccessToken(rotated.access_token))?.userId,
    ).toBe(githubUser);
    const revoke = await request("/oauth2/revoke", {
      client_id: "me-cli",
      token: rotated.access_token,
      token_type_hint: "access_token",
    });
    expect(revoke.status).toBe(200);
    expect(
      await instance.verifyOAuthAccessToken(rotated.access_token),
    ).toBeNull();
  });

  test("code replay revokes already-issued access tokens in place", async () => {
    const { tokens, body } = await codeTokens();
    const replay = await request("/oauth2/token", body);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
  });

  test("sign-out revokes existing access but deliberately preserves offline refresh", async () => {
    const { session, tokens } = await codeTokens();
    const response = await request("/sign-out", {}, session.signed);
    expect(response.status).toBe(200);
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
    const [row] = await sql.unsafe(
      `select revoked from ${schema}.oauth_access_token where token = $1`,
      [hash(tokens.access_token)],
    );
    expect(row?.revoked).not.toBeNull();
    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const fresh = (await rotated.json()) as { access_token: string };
    expect(
      (await instance.verifyOAuthAccessToken(fresh.access_token))?.userId,
    ).toBe(githubUser);
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
  });

  test("sign-out revokes refresh grants without offline_access", async () => {
    const { session, tokens } = await onlineTokens();
    expect((await request("/sign-out", {}, session.signed)).status).toBe(200);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });

  test("offline refresh before the sweep detaches only that grant and issues accepted access", async () => {
    const { session, tokens } = await codeTokens();
    const unrelated = await browserSession();
    await expireSession(session.id);
    await expireSession(unrelated.id);
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();

    const response = await refresh(tokens.refresh_token);
    expect(response.status).toBe(200);
    const fresh = (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(
      (await instance.verifyOAuthAccessToken(fresh.access_token))?.userId,
    ).toBe(githubUser);
    const [access] = await sql.unsafe(
      `select session_id from ${schema}.oauth_access_token where token = $1`,
      [hash(fresh.access_token)],
    );
    expect(access?.session_id).toBeNull();
    const [oldAccess] = await sql.unsafe(
      `select session_id from ${schema}.oauth_access_token where token = $1`,
      [hash(tokens.access_token)],
    );
    expect(oldAccess?.session_id).toBe(session.id);
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
    // No per-request sweep: even this grant's expired browser row stays put.
    const [sessions] = await sql.unsafe(
      `select count(*)::int as n from ${schema}.sessions where id in ($1, $2)`,
      [session.id, unrelated.id],
    );
    expect(sessions?.n).toBe(2);
    expect((await refresh(fresh.refresh_token)).status).toBe(200);
    await sql.unsafe(`select ${schema}.cleanup_expired_sessions()`);
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
    expect(
      await instance.verifyOAuthAccessToken(fresh.access_token),
    ).not.toBeNull();
  });

  test.each([
    false,
    true,
  ])("online-only refresh cannot survive session expiry (swept=%s)", async (swept) => {
    const { session, tokens } = await onlineTokens();
    await expireSession(session.id);
    if (swept) await sql.unsafe(`select ${schema}.cleanup_expired_sessions()`);
    const [row] = await sql.unsafe(
      `select revoked, session_id from ${schema}.oauth_refresh_token where token = $1`,
      [hash(tokens.refresh_token)],
    );
    if (swept) {
      expect(row?.session_id).toBeNull();
      expect(row?.revoked).not.toBeNull();
    }
    const response = await refresh(tokens.refresh_token);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
  });

  test("direct API refresh calls also normalize expired offline sessions", async () => {
    const { session, tokens } = await codeTokens();
    await expireSession(session.id);
    const fresh = await instance.auth.api.oauth2Token({
      body: {
        grant_type: "refresh_token",
        client_id: "me-cli",
        refresh_token: tokens.refresh_token,
      },
    });
    expect(
      await instance.verifyOAuthAccessToken(fresh.access_token),
    ).not.toBeNull();
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
  });

  test("grant-type whitespace accepted by the provider cannot bypass online expiry checks", async () => {
    const { session, tokens } = await onlineTokens();
    await expireSession(session.id);
    const response = await request("/oauth2/token", {
      grant_type: " refresh_token ",
      client_id: "me-cli",
      refresh_token: tokens.refresh_token,
    });
    expect(response.status).toBe(400);
  });

  test("active-session online refresh remains allowed, but an unbound online grant cannot refresh", async () => {
    const online = await onlineTokens();
    const active = await refresh(online.tokens.refresh_token);
    expect(active.status).toBe(200);
    const accepted = (await active.json()) as { access_token: string };
    expect(
      await instance.verifyOAuthAccessToken(accepted.access_token),
    ).not.toBeNull();

    const { session, tokens } = await codeTokens();
    await expireSession(session.id);
    // This valid offline refresh narrows its scope AFTER detachment; the new
    // refresh row no longer carries offline permission and has no browser.
    const narrowed = await refresh(tokens.refresh_token, "profile");
    expect(narrowed.status).toBe(200);
    const fresh = (await narrowed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(
      await instance.verifyOAuthAccessToken(fresh.access_token),
    ).not.toBeNull();
    expect((await refresh(fresh.refresh_token)).status).toBe(400);
  });

  test("refresh expiry normalization serializes with a concurrent browser-session extension", async () => {
    const { session, tokens } = await codeTokens();
    await expireSession(session.id);
    const blocker = await instance.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query(
        "update sessions set expires_at = now() + interval '1 day' where id = $1",
        [session.id],
      );
      pending = refresh(tokens.refresh_token);
      // Wait for the helper's session lock, rather than assuming scheduling.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [row] = await sql`select exists (
          select 1 from pg_stat_activity where application_name = 'me-auth'
          and query like 'select prepare_oauth_refresh%'
          and wait_event_type = 'Lock'
        ) as waiting`;
        waiting = row?.waiting === true;
        if (!waiting) await Bun.sleep(5);
      }
      expect(waiting).toBe(true);
      await blocker.query("commit");
      const response = await pending;
      expect(response.status).toBe(200);
      const fresh = (await response.json()) as { access_token: string };
      expect(
        await instance.verifyOAuthAccessToken(fresh.access_token),
      ).not.toBeNull();
      const [access] = await sql.unsafe(
        `select session_id from ${schema}.oauth_access_token where token = $1`,
        [hash(fresh.access_token)],
      );
      expect(access?.session_id).toBe(session.id);
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await pending;
    }
  });

  test("offline refresh still works after the expired-session sweep", async () => {
    const { session, tokens } = await codeTokens();
    await expireSession(session.id);
    await sql.unsafe(`select ${schema}.cleanup_expired_sessions()`);
    const response = await refresh(tokens.refresh_token);
    expect(response.status).toBe(200);
    const fresh = (await response.json()) as { access_token: string };
    expect(
      await instance.verifyOAuthAccessToken(fresh.access_token),
    ).not.toBeNull();
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
  });

  test("explicit unknown audiences are rejected at authorization", async () => {
    const session = await browserSession();
    const { response } = await authorize(session.signed, {
      resource: "https://other.example/api",
    });
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("Location") ?? "");
    expect(redirect.searchParams.get("error")).toBe("invalid_target");
  });

  test("a configured resource is not requestable without an explicit client link", async () => {
    await sql.unsafe(
      `insert into ${schema}.oauth_resource(identifier, name) values ('https://other.example/api', 'Other API')`,
    );
    const session = await browserSession();
    const { response } = await authorize(session.signed, {
      resource: "https://other.example/api",
    });
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("Location") ?? "").searchParams.get("error"),
    ).toBe("invalid_target");
  });

  test("userinfo-audience JWTs cannot authenticate an RPC API", async () => {
    const session = await browserSession();
    const resource = `${BASE}${AUTH_BASE_PATH}/oauth2/userinfo`;
    const { response, verifier } = await authorize(session.signed, {
      resource,
      scope: "openid profile email offline_access",
    });
    expect(response.status).toBe(302);
    const code =
      new URL(response.headers.get("Location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const result = await request("/oauth2/token", {
      grant_type: "authorization_code",
      client_id: "me-cli",
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
      resource,
    });
    expect(result.status).toBe(200);
    const tokens = (await result.json()) as { access_token: string };
    const payload = tokens.access_token.split(".")[1] ?? "";
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).aud).toBe(
      resource,
    );
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
  });

  test("a resource cannot be added to an unbound authorization at token exchange", async () => {
    const session = await browserSession();
    const { response, verifier } = await authorize(session.signed);
    const code =
      new URL(response.headers.get("Location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const token = await request("/oauth2/token", {
      grant_type: "authorization_code",
      client_id: "me-cli",
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
      resource: "https://other.example/api",
    });
    expect(token.status).toBe(400);
    expect(((await token.json()) as { error: string }).error).toBe(
      "invalid_target",
    );
  });

  test("the resource server rejects foreign audiences, DPoP-bound, revoked, expired-session and disabled-client tokens", async () => {
    const { session, tokens } = await codeTokens();
    for (const mutation of [
      "resources = '[\"https://other.example/api\"]'::jsonb",
      "resources = '[\"http://localhost:3000/api/v1/auth/oauth2/userinfo\"]'::jsonb",
      "resources = 'null'::jsonb",
      'confirmation = \'{"jkt":"binding"}\'::jsonb',
      "revoked = now()",
    ]) {
      await sql.unsafe(
        `update ${schema}.oauth_access_token set ${mutation} where token = $1`,
        [hash(tokens.access_token)],
      );
      expect(
        await instance.verifyOAuthAccessToken(tokens.access_token),
      ).toBeNull();
      await sql.unsafe(
        `update ${schema}.oauth_access_token set resources = null, confirmation = null, revoked = null where token = $1`,
        [hash(tokens.access_token)],
      );
    }
    await sql.unsafe(
      `update ${schema}.sessions set expires_at = now() - interval '1 second' where id = $1`,
      [session.id],
    );
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
    await sql.unsafe(
      `update ${schema}.sessions set expires_at = now() + interval '1 day' where id = $1`,
      [session.id],
    );
    await sql.unsafe(
      `update ${schema}.oauth_client set disabled = true where client_id = 'me-cli'`,
    );
    try {
      expect(
        await instance.verifyOAuthAccessToken(tokens.access_token),
      ).toBeNull();
    } finally {
      await sql.unsafe(
        `update ${schema}.oauth_client set disabled = false where client_id = 'me-cli'`,
      );
    }
  });

  test("sweeping an expired session does not resurrect its access tokens via SET NULL", async () => {
    const { session, tokens } = await codeTokens();
    await sql.unsafe(
      `update ${schema}.sessions set expires_at = now() - interval '1 second' where id = $1`,
      [session.id],
    );
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
    await sql.unsafe(`select ${schema}.cleanup_expired_sessions()`);
    const [row] = await sql.unsafe(
      `select session_id, revoked from ${schema}.oauth_access_token where token = $1`,
      [hash(tokens.access_token)],
    );
    expect(row?.session_id).toBeNull();
    expect(row?.revoked).not.toBeNull();
    expect(
      await instance.verifyOAuthAccessToken(tokens.access_token),
    ).toBeNull();
  });

  test("session creation still rejects an unverified identity", async () => {
    const [user] = await sql.unsafe(
      `insert into ${schema}.users(name, email, email_verified) values ('Unverified', 'unverified@example.com', false) returning id`,
    );
    const ctx = await instance.auth.$context;
    await expect(
      ctx.internalAdapter.createSession(user?.id as string, false),
    ).rejects.toThrow("Your email is not verified");
  });

  test("PKCE and redirect protections are still enforced", async () => {
    const session = await browserSession();
    const { response } = await authorize(session.signed, {
      code_challenge: "",
      code_challenge_method: "",
    });
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("Location") ?? "").searchParams.has("error"),
    ).toBe(true);
    const bad = await authorize(session.signed, {
      redirect_uri: "http://evil.example/callback",
    });
    expect(bad.response.headers.get("Location") ?? "").not.toStartWith(
      "http://evil.example",
    );
  });
});

test("an omitted-type legacy loopback client requires review; explicit native remediation survives name-only updates", async () => {
  const name = randomAuthSchema();
  let migrated: ReturnType<typeof createBetterAuth> | undefined;
  try {
    await legacySchema(name);
    const [user] = await sql.unsafe(
      `insert into ${name}.users(name, email, email_verified) values ('Native owner', 'native@example.com', true) returning id`,
    );
    // Valid 1.6 registration: deliberately OMIT type, not an invented null
    // application_type inserted after the upgrade.
    await sql.unsafe(
      `insert into ${name}.oauth_client
       (client_id, name, public, user_id, redirect_uris, grant_types, response_types, token_endpoint_auth_method, require_pkce)
       values ('legacy-untyped', 'Native app', true, $1, '["http://127.0.0.1/callback"]', '["authorization_code","refresh_token"]', '["code"]', 'none', true)`,
      [user?.id],
    );
    await expect(migrateAuth(sql, { schema: name })).rejects.toThrow(
      "Review OAuth client types",
    );
    // Operator reviews this registration and explicitly chooses native; the
    // migration itself must not infer application policy from its redirects.
    await sql.unsafe(
      `update ${name}.oauth_client set type = 'native' where client_id = 'legacy-untyped'`,
    );
    await migrateAuth(sql, { schema: name });
    await migrateAuth(sql, { schema: name });
    migrated = createBetterAuth({
      databaseUrl: DB,
      authSchema: name,
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [BASE],
    });
    const ctx = await migrated.auth.$context;
    const session = await ctx.internalAdapter.createSession(
      user?.id as string,
      false,
    );
    const signed = await signSessionTokenForBearer(session.token, SECRET);
    const response = await handleBetterAuthRequest(
      migrated.auth,
      new Request(`${BASE}${AUTH_BASE_PATH}/oauth2/update-client`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signed}`,
        },
        body: JSON.stringify({
          client_id: "legacy-untyped",
          update: { client_name: "Renamed native app" },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as {
      application_type: string;
      client_name: string;
      redirect_uris: string[];
    };
    expect(updated.application_type).toBe("native");
    expect(updated.client_name).toBe("Renamed native app");
    expect(updated.redirect_uris).toEqual(["http://127.0.0.1/callback"]);
    const [client] = await sql.unsafe(
      `select application_type, type from ${name}.oauth_client where client_id = 'legacy-untyped'`,
    );
    expect(client?.application_type).toBe("native");
    expect(client?.type).toBe("native");
  } finally {
    await migrated?.pool.end();
    await sql.unsafe(`drop schema if exists ${name} cascade`);
  }
});

test.each([
  {
    name: "omitted type with legacy loopback redirect",
    mutation: "type = null",
    message: "Review OAuth client types",
  },
  {
    name: "unmapped type",
    mutation: "type = 'user-agent'",
    message: "Review OAuth client types",
  },
  {
    name: "public client with confidential method",
    mutation: "token_endpoint_auth_method = 'client_secret_basic'",
    message: "Review conflicting public OAuth client",
  },
  {
    name: "confidential client with public method",
    mutation: "public = false, token_endpoint_auth_method = 'none'",
    message: "Review conflicting public OAuth client",
  },
])("$name fails migration atomically instead of weakening policy", async ({
  mutation,
  message,
}) => {
  const name = randomAuthSchema();
  try {
    await legacySchema(name);
    await sql.unsafe(`update ${name}.oauth_client set ${mutation}`);
    await expect(migrateAuth(sql, { schema: name })).rejects.toThrow(message);
    const [version] = await sql.unsafe(`select version from ${name}.version`);
    expect(version?.version).toBe("0.0.2");
    const columns =
      await sql`select column_name from information_schema.columns where table_schema = ${name} and table_name = 'oauth_client'`;
    expect(columns.some((row) => row.column_name === "application_type")).toBe(
      false,
    );
  } finally {
    await sql.unsafe(`drop schema if exists ${name} cascade`);
  }
});
