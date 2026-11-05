import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { migrateAuth } from "@memory.build/database";
import { makeSignature } from "better-auth/crypto";
import postgres, { type Sql } from "postgres";
import { buildAuthorizeCallbackURL } from "../../web/src/lib/oauth-callback";
import {
  AUTH_BASE_PATH,
  CLI_CLIENT_ID,
  createBetterAuth,
  signSessionTokenForBearer,
} from "./betterauth";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";
const BASE = "http://localhost:3000";
const AUTH = `${BASE}${AUTH_BASE_PATH}`;
const SECRET = "test-secret-betterauth-0123456789";
const SCOPES = ["openid", "profile", "email", "offline_access"];
const authSchema = `auth_test_${crypto.randomUUID().replaceAll("-", "")}`;
let sql: Sql;
let betterAuth: ReturnType<typeof createBetterAuth>;
let alice: Browser;
let bob: Browser;

type Browser = { id: string; email: string; cookie: string };
type Method = "GET" | "POST";

beforeAll(async () => {
  sql = postgres(DATABASE_URL, { onnotice: () => {} });
  await migrateAuth(sql, { schema: authSchema });
  betterAuth = createBetterAuth({
    databaseUrl: DATABASE_URL,
    authSchema,
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [BASE],
    rateLimitEnabled: false,
  });
});

beforeEach(async () => {
  await sql.unsafe(`delete from ${authSchema}.users`);
  await sql.unsafe(
    `update ${authSchema}.oauth_client
     set disabled = false, skip_consent = false
     where client_id = $1`,
    [CLI_CLIENT_ID],
  );
  alice = await browser("alice@example.com");
  bob = await browser("bob@example.com");
});

afterAll(async () => {
  await betterAuth?.pool.end();
  await sql.unsafe(`drop schema if exists ${authSchema} cascade`);
  await sql.end();
});

async function browser(email: string): Promise<Browser> {
  const [user] = await sql.unsafe<{ id: string }[]>(
    `insert into ${authSchema}.users (name, email, email_verified)
     values ('Consent Test', $1, true)
     returning id`,
    [email],
  );
  if (!user) throw new Error("User was not created");
  const ctx = await betterAuth.auth.$context;
  const session = await ctx.internalAdapter.createSession(user.id, false);
  if (!session) throw new Error("Session was not created");
  const signed = await signSessionTokenForBearer(session.token, SECRET);
  const cookie = `me.session_token=${signed}`;
  const resolved = await betterAuth.auth.api.getSession({
    headers: new Headers({ Cookie: cookie }),
  });
  expect(resolved?.user.id).toBe(user.id);
  return { id: user.id, email, cookie };
}

function flow() {
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = "http://127.0.0.1:49153/callback";
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return { verifier, redirectUri, state, query };
}

async function authorize(
  query: URLSearchParams,
  method: Method = "GET",
  user: Browser | undefined = alice,
) {
  return betterAuth.auth.handler(
    new Request(
      `${AUTH}/oauth2/authorize${method === "GET" ? `?${query}` : ""}`,
      {
        method,
        headers: {
          Accept: "text/html",
          Origin: BASE,
          ...(user ? { Cookie: user.cookie } : {}),
        },
        body: method === "POST" ? query : undefined,
      },
    ),
  );
}

async function post(
  endpoint: string,
  body: unknown,
  user: Browser | undefined = alice,
  headers: Record<string, string> = {},
) {
  return betterAuth.auth.handler(
    new Request(`${AUTH}/oauth2/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: BASE,
        ...(user ? { Cookie: user.cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function consentURL(response: Response) {
  let location: string;
  if (response.status === 302) {
    location = response.headers.get("Location") ?? "";
  } else {
    expect(response.status).toBe(200);
    const body = (await response.json()) as { redirect: boolean; url: string };
    expect(body.redirect).toBe(true);
    location = body.url;
  }
  const url = new URL(location, BASE);
  expect(url.origin + url.pathname).toBe(`${BASE}/consent`);
  expect(url.searchParams.has("code")).toBe(false);
  expect(url.searchParams.get("prompt")?.split(/\s+/)).toContain("consent");
  expect(await verifyOAuthQueryParams(url.search, SECRET)).toBe(true);
  return url;
}

async function pending(method: Method = "GET") {
  const request = flow();
  const url = await consentURL(await authorize(request.query, method));
  expect(url.searchParams.get("state")).toBe(request.state);
  expect(url.searchParams.get("redirect_uri")).toBe(request.redirectUri);
  return { ...request, url };
}

async function decide(oauthQuery: string, accept: boolean, user = alice) {
  return post("consent", { accept, oauth_query: oauthQuery }, user, {
    "X-Me-Consent-Account": user.id,
  });
}

async function token(params: Record<string, string>) {
  return betterAuth.auth.handler(
    new Request(`${AUTH}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, ...params }),
    }),
  );
}

async function expectNoGrants() {
  const [row] = await sql.unsafe(
    `select
       (select count(*)::int from ${authSchema}.oauth_consent) as consents
     , (select count(*)::int from ${authSchema}.oauth_access_token) as access
     , (select count(*)::int from ${authSchema}.oauth_refresh_token) as refresh`,
  );
  expect(row).toMatchObject({ consents: 0, access: 0, refresh: 0 });
}

async function expectRejected(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.has("Location")).toBe(false);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.access_token).toBeUndefined();
  expect(body.refresh_token).toBeUndefined();
  expect(body.url).toBeUndefined();
  await expectNoGrants();
}

describe("CLI browser approval through the OAuth provider", () => {
  test("requires approval even when the client metadata skips consent", async () => {
    await sql.unsafe(
      `update ${authSchema}.oauth_client set skip_consent = true where client_id = $1`,
      [CLI_CLIENT_ID],
    );
    await pending();
    await expectNoGrants();
  });

  test("anonymous authorization preserves the consent requirement through login", async () => {
    const request = flow();
    const anonymous: Browser = { id: "", email: "", cookie: "" };
    const response = await authorize(request.query, "GET", anonymous);
    expect(response.status).toBe(302);
    const login = new URL(response.headers.get("Location") ?? "", BASE);
    expect(login.origin + login.pathname).toBe(`${BASE}/login`);
    expect(login.searchParams.get("state")).toBe(request.state);
    expect(login.searchParams.get("prompt")?.split(/\s+/)).toContain("consent");
    expect(await verifyOAuthQueryParams(login.search, SECRET)).toBe(true);
    await expectNoGrants();
  });

  test.each([
    "GET",
    "POST",
  ] as const)("%s requires consent for a signed-in user when prompt is omitted", async (method) => {
    const request = await pending(method);
    expect(request.query.has("prompt")).toBe(false);
    await expectNoGrants();
  });

  test.each([
    "GET",
    "POST",
  ] as const)("%s requires fresh consent despite an existing grant", async (method) => {
    await sql.unsafe(
      `insert into ${authSchema}.oauth_consent (client_id, user_id, scopes)
         values ($1, $2, $3::jsonb)`,
      [CLI_CLIENT_ID, alice.id, JSON.stringify(SCOPES)],
    );
    await pending(method);
    const [row] = await sql.unsafe(
      `select count(*)::int as count from ${authSchema}.oauth_access_token`,
    );
    expect(row?.count).toBe(0);
  });

  test("account switching restores consent after the login callback rebuild", async () => {
    const first = await pending();
    expect((await decide(first.url.search, true)).status).toBe(200);
    const request = flow();
    request.query.set("prompt", "login");
    const response = await authorize(request.query);
    expect(response.status).toBe(302);
    const login = new URL(response.headers.get("Location") ?? "", BASE);
    expect(login.pathname).toBe("/login");
    expect(await verifyOAuthQueryParams(login.search, SECRET)).toBe(true);
    const callback = new URL(buildAuthorizeCallbackURL(login.search), BASE);
    expect(callback.searchParams.has("prompt")).toBe(false);
    const approval = await consentURL(await authorize(callback.searchParams));
    for (const key of [
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]) {
      expect(approval.searchParams.get(key)).toBe(request.query.get(key));
    }
    const [row] = await sql.unsafe(
      `select count(*)::int as count from ${authSchema}.oauth_access_token`,
    );
    expect(row?.count).toBe(0);
  });

  test("replaying a signed approval envelope at authorize still requires consent", async () => {
    const first = await pending();
    expect((await decide(first.url.search, true)).status).toBe(200);
    const approval = await consentURL(await authorize(first.url.searchParams));
    expect(approval.searchParams.get("state")).toBe(first.state);
    const [row] = await sql.unsafe(
      `select count(*)::int as count from ${authSchema}.oauth_access_token`,
    );
    expect(row?.count).toBe(0);
  });

  test.each([
    "GET",
    "POST",
  ] as const)("%s rejects prompt=none instead of silently authorizing", async (method) => {
    const request = flow();
    request.query.set("prompt", "none");
    const response = await authorize(request.query, method);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "consent_required" });
    await expectNoGrants();
  });

  test.each([
    "GET",
    "POST",
  ] as const)("%s cannot bypass approval with spoofed acceptance flags", async (method) => {
    const request = flow();
    request.query.set("accept", "true");
    request.query.set("selected", "true");
    request.query.set("created", "true");
    request.query.set("postLogin", "true");
    await consentURL(await authorize(request.query, method));
    await expectNoGrants();
  });

  test("a JSON authorize request with boolean accept cannot impersonate native consent", async () => {
    const request = flow();
    const response = await post("authorize", {
      ...Object.fromEntries(request.query),
      accept: true,
    });
    if (response.status >= 400) {
      // The provider can reject this media type before authorization starts.
      expect(response.status).toBeLessThan(500);
    } else {
      await consentURL(response);
    }
    await expectNoGrants();
  });

  test.each([
    "selected",
    "created",
    "postLogin",
  ])("continue with %s cannot replace consent", async (flag) => {
    const request = await pending();
    await consentURL(
      await post("continue", {
        [flag]: true,
        accept: true,
        oauth_query: request.url.search,
      }),
    );
    await expectNoGrants();
  });

  test("details show the account, client, callback and scopes that approval uses", async () => {
    const request = await pending();
    const detailsResponse = await post("cli-consent-details", {
      oauth_query: request.url.search,
    });
    expect(detailsResponse.status).toBe(200);
    expect(detailsResponse.headers.get("Cache-Control")).toBe("no-store");
    const details = (await detailsResponse.json()) as {
      user: { id: string; email: string };
      clientName: string;
      redirectUri: string;
      scopes: string[];
    };
    expect(details).toEqual({
      user: { id: alice.id, email: alice.email },
      clientName: "me CLI",
      redirectUri: request.redirectUri,
      scopes: SCOPES,
    });
    await expectNoGrants();

    const approved = await decide(request.url.search, true);
    expect(approved.status).toBe(200);
    const approval = (await approved.json()) as {
      redirect: boolean;
      url: string;
    };
    expect(approval.redirect).toBe(true);
    const callback = new URL(approval.url);
    expect(callback.origin + callback.pathname).toBe(details.redirectUri);
    expect(callback.searchParams.get("state")).toBe(request.state);
    expect(callback.searchParams.has("error")).toBe(false);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const wrongVerifier = await token({
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: randomBytes(32).toString("base64url"),
      redirect_uri: request.redirectUri,
    });
    expect(wrongVerifier.status).toBe(400);
    const [empty] = await sql.unsafe(
      `select count(*)::int as count from ${authSchema}.oauth_access_token`,
    );
    expect(empty?.count).toBe(0);

    // Use a new code because the provider can consume a failed exchange.
    const retry = await pending();
    const retryResponse = await decide(retry.url.search, true);
    expect(retryResponse.status).toBe(200);
    const retryApproval = (await retryResponse.json()) as { url: string };
    const retryCode = new URL(retryApproval.url).searchParams.get("code");
    expect(retryCode).toBeTruthy();
    const exchanged = await token({
      grant_type: "authorization_code",
      code: retryCode ?? "",
      code_verifier: retry.verifier,
      redirect_uri: retry.redirectUri,
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope.split(" ").sort()).toEqual([...details.scopes].sort());
    expect(
      await betterAuth.verifyOAuthAccessToken(tokens.access_token),
    ).toMatchObject({ userId: alice.id, email: alice.email });
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(rotated.access_token).toBeTruthy();
    expect(rotated.refresh_token).toBeTruthy();
    expect(
      await betterAuth.verifyOAuthAccessToken(rotated.access_token),
    ).toMatchObject({ userId: alice.id, email: alice.email });
  });

  test("denial returns access_denied and the original state without a grant", async () => {
    const request = await pending();
    const denied = await decide(request.url.search, false);
    expect(denied.status).toBe(200);
    const body = (await denied.json()) as { redirect: boolean; url: string };
    expect(body.redirect).toBe(true);
    const callback = new URL(body.url);
    expect(callback.origin + callback.pathname).toBe(request.redirectUri);
    expect(callback.searchParams.get("state")).toBe(request.state);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.has("code")).toBe(false);
    await expectNoGrants();
  });

  test.each([
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "prompt",
    "sig",
  ])("rejects a modified signed %s in details, approval and denial", async (field) => {
    const request = await pending();
    const tampered = new URLSearchParams(request.url.search);
    tampered.set(
      field,
      field === "redirect_uri" ? "http://127.0.0.1:49154/callback" : "tampered",
    );
    await expectRejected(
      await post("cli-consent-details", { oauth_query: tampered.toString() }),
      400,
    );
    for (const accept of [true, false]) {
      await expectRejected(await decide(tampered.toString(), accept), 400);
    }
  });

  test.each([
    "unsigned",
    "duplicate signature",
  ])("rejects an %s envelope", async (kind) => {
    const request = await pending();
    const query = new URLSearchParams(request.url.search);
    if (kind === "unsigned") query.delete("sig");
    else query.append("sig", query.get("sig") ?? "");
    await expectRejected(
      await post("cli-consent-details", { oauth_query: query.toString() }),
      400,
    );
    for (const accept of [true, false]) {
      await expectRejected(await decide(query.toString(), accept), 400);
    }
  });

  test("rejects an expired but correctly signed envelope", async () => {
    const request = await pending();
    const query = new URLSearchParams(request.url.search);
    const originalSignature = query.get("sig") ?? "";
    query.delete("sig");
    // Use the provider's canonical order and signer. Do not change the clock.
    const signature = (params: URLSearchParams) => {
      const sorted = [...params.entries()].sort(([a, av], [b, bv]) =>
        a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
      );
      return makeSignature(new URLSearchParams(sorted).toString(), SECRET);
    };
    expect(await signature(query)).toBe(originalSignature);
    query.set("exp", String(Math.floor(Date.now() / 1000) - 60));
    query.set("sig", await signature(query));
    await expectRejected(
      await post("cli-consent-details", { oauth_query: query.toString() }),
      400,
    );
    for (const accept of [true, false]) {
      await expectRejected(await decide(query.toString(), accept), 400);
    }
  });

  test("requires a session to read details, approve or deny", async () => {
    const request = await pending();
    const anonymous: Browser = { id: alice.id, email: alice.email, cookie: "" };
    await expectRejected(
      await post(
        "cli-consent-details",
        { oauth_query: request.url.search },
        anonymous,
      ),
      401,
    );
    for (const accept of [true, false]) {
      await expectRejected(
        await decide(request.url.search, accept, anonymous),
        401,
      );
    }
  });

  test("rejects a missing account confirmation and a changed browser account", async () => {
    const request = await pending();
    for (const accept of [true, false]) {
      await expectRejected(
        await post("consent", { accept, oauth_query: request.url.search }),
        403,
      );
      await expectRejected(
        await post(
          "consent",
          { accept, oauth_query: request.url.search },
          bob,
          {
            "X-Me-Consent-Account": alice.id,
          },
        ),
        403,
      );
    }
    const current = await post(
      "cli-consent-details",
      { oauth_query: request.url.search },
      bob,
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      user: { id: bob.id, email: bob.email },
    });
    await expectNoGrants();
  });

  test("rejects cross-origin details, approval and denial", async () => {
    const request = await pending();
    for (const endpoint of ["cli-consent-details", "consent"]) {
      for (const accept of [true, false]) {
        await expectRejected(
          await post(
            endpoint,
            { accept, oauth_query: request.url.search },
            alice,
            {
              Origin: "https://attacker.invalid",
              "X-Me-Consent-Account": alice.id,
            },
          ),
          403,
        );
      }
    }
  });

  test.each([
    "",
    "null",
  ])("rejects cookie-authenticated decisions with an invalid origin: %s", async (origin) => {
    const request = await pending();
    await expectRejected(
      await post(
        "consent",
        { accept: true, oauth_query: request.url.search },
        alice,
        {
          Origin: origin,
          "X-Me-Consent-Account": alice.id,
        },
      ),
      403,
    );
  });

  test("details reject a client disabled after the request was signed", async () => {
    const request = await pending();
    await sql.unsafe(
      `update ${authSchema}.oauth_client set disabled = true where client_id = $1`,
      [CLI_CLIENT_ID],
    );
    await expectRejected(
      await post("cli-consent-details", { oauth_query: request.url.search }),
      400,
    );
  });
});
