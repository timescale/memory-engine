import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { migrateAuth } from "@memory.build/database";
import postgres, { type Sql } from "postgres";
import { buildAuthorizeCallbackURL } from "../../web/src/lib/oauth-callback";
import {
  clearSignInError,
  readSignInError,
} from "../../web/src/lib/sign-in-error";
import {
  AUTH_BASE_PATH,
  type Auth,
  CLI_CLIENT_ID,
  createBetterAuth,
} from "./betterauth";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";
const BASE = "http://localhost:3000";
const AUTH = `${BASE}${AUTH_BASE_PATH}`;
const authSchema = `auth_test_${crypto.randomUUID().replaceAll("-", "")}`;
let sql: Sql;
let restricted: ReturnType<typeof createBetterAuth>;
let unrestricted: ReturnType<typeof createBetterAuth>;

beforeAll(async () => {
  sql = postgres(DATABASE_URL, { onnotice: () => {} });
  await migrateAuth(sql, { schema: authSchema });
  const options = {
    databaseUrl: DATABASE_URL,
    authSchema,
    baseURL: BASE,
    secret: "test-secret-betterauth-0123456789",
    trustedOrigins: [BASE],
    github: { clientId: "test-github", clientSecret: "test-secret" },
    google: { clientId: "test-google", clientSecret: "test-secret" },
    rateLimitEnabled: false,
  };
  restricted = createBetterAuth({
    ...options,
    signupEmailDomain: " TigerData.COM ",
  });
  unrestricted = createBetterAuth(options);
});

beforeEach(async () => {
  // Preserve the migration-seeded me-cli client (TRUNCATE CASCADE removes it).
  await sql.unsafe(`delete from ${authSchema}.users`);
});

afterAll(async () => {
  await restricted?.pool.end();
  await unrestricted?.pool.end();
  await sql.unsafe(`drop schema if exists ${authSchema} cascade`);
  await sql.end();
});

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

/** Real state cookies and callback handler; only provider I/O is stubbed. */
async function signIn(
  auth: Auth,
  providerId: "github" | "google",
  email: string,
  emailVerified = true,
  accountId = crypto.randomUUID(),
  loginSearch?: string,
) {
  const ctx = await auth.$context;
  const provider = ctx.socialProviders.find((p) => p.id === providerId);
  if (!provider) throw new Error(`missing provider ${providerId}`);
  provider.createAuthorizationURL = async ({ state }) =>
    new URL(`https://provider.invalid/authorize?state=${state}`);
  const tokens = mock(async () => ({
    accessToken: "test-access-token",
    scopes: ["email"],
  }));
  const userInfo = mock(async () => ({
    user: { id: accountId, email, emailVerified, name: "Test User" },
    data: {},
  }));
  provider.validateAuthorizationCode = tokens;
  provider.getUserInfo = userInfo;

  // Mirror LoginPage: clear the previous error before building either redirect.
  const search = clearSignInError(loginSearch ?? "");
  const start = await auth.handler(
    new Request(`${AUTH}/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({
        provider: providerId,
        callbackURL:
          loginSearch === undefined
            ? `${BASE}/signed-in`
            : buildAuthorizeCallbackURL(search),
        errorCallbackURL: `/login${search}`,
      }),
    }),
  );
  expect(start.status).toBe(200);
  const body = (await start.json()) as { url: string };
  const state = new URL(body.url).searchParams.get("state");
  expect(state).toBeTruthy();
  const response = await auth.handler(
    new Request(
      `${AUTH}/callback/${providerId}?code=test-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { Cookie: cookies(start) } },
    ),
  );
  expect(tokens).toHaveBeenCalledTimes(1);
  expect(userInfo).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(302);
  return response;
}

async function signedInUser(auth: Auth, response: Response) {
  expect(response.headers.get("Location")).toBe(`${BASE}/signed-in`);
  expect(response.headers.get("Set-Cookie")).toContain("me.session_token=");
  const session = await auth.api.getSession({
    headers: new Headers({ Cookie: cookies(response) }),
  });
  expect(session?.user.id).toBeTruthy();
  if (!session) throw new Error("missing session");
  return session.user;
}

async function counts() {
  const [row] = await sql.unsafe<
    { users: number; accounts: number; sessions: number }[]
  >(`select
    (select count(*)::int from ${authSchema}.users) as users,
    (select count(*)::int from ${authSchema}.accounts) as accounts,
    (select count(*)::int from ${authSchema}.sessions) as sessions`);
  return row;
}

async function startCliAuthorization(auth: Auth) {
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = "http://127.0.0.1:49152/callback";
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const response = await auth.handler(
    new Request(`${AUTH}/oauth2/authorize?${query}`),
  );
  expect(response.status).toBe(302);
  const loginURL = new URL(response.headers.get("Location") ?? "", BASE);
  expect(loginURL.origin + loginURL.pathname, loginURL.href).toBe(
    `${BASE}/login`,
  );
  expect(loginURL.searchParams.get("sig")).toBeTruthy();
  return { loginURL, verifier, redirectUri, state };
}

async function requestTokens(auth: Auth, params: Record<string, string>) {
  const response = await auth.handler(
    new Request(`${AUTH}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, ...params }),
    }),
  );
  expect(response.status).toBe(200);
  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  return tokens;
}

async function exchangeCliCode(
  auth: Auth,
  flow: Awaited<ReturnType<typeof startCliAuthorization>>,
  signedIn: Response,
) {
  const callback = new URL(signedIn.headers.get("Location") ?? "", BASE);
  expect(callback.origin + callback.pathname).toBe(`${AUTH}/oauth2/authorize`);
  const authorized = await auth.handler(
    new Request(callback.href, { headers: { Cookie: cookies(signedIn) } }),
  );
  expect(authorized.status).toBe(302);
  const loopback = new URL(authorized.headers.get("Location") ?? "");
  expect(loopback.origin + loopback.pathname).toBe(flow.redirectUri);
  expect(loopback.searchParams.get("state")).toBe(flow.state);
  expect(loopback.searchParams.get("code")).toBeTruthy();
  return requestTokens(auth, {
    grant_type: "authorization_code",
    code: loopback.searchParams.get("code") ?? "",
    code_verifier: flow.verifier,
    redirect_uri: flow.redirectUri,
  });
}

function expectError(response: Response, error: string) {
  const location = new URL(response.headers.get("Location") ?? "", BASE);
  expect(location.origin + location.pathname).toBe(`${BASE}/login`);
  expect(location.searchParams.get("error")).toBe(error);
  expect(response.headers.get("Set-Cookie") ?? "").not.toContain(
    "me.session_token=",
  );
}

describe("signup restriction through the OAuth callback", () => {
  test.each([
    "github",
    "google",
  ] as const)("%s permits a new verified exact-domain user", async (provider) => {
    const response = await signIn(
      restricted.auth,
      provider,
      "New.User@TIGERDATA.COM",
    );
    const user = await signedInUser(restricted.auth, response);
    expect(user.email).toBe("new.user@tigerdata.com");
    expect(await counts()).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  test.each([
    "person@example.com",
    "person@sub.tigerdata.com",
    "person@eviltigerdata.com",
    "person@tigerdata.com.evil",
    "person@tigerdata.com@evil.com",
  ])("blocks %s without creating a user, account, or session", async (email) => {
    const response = await signIn(restricted.auth, "github", email);
    expectError(response, "SIGNUP_RESTRICTED:tigerdata.com");
    expect(await counts()).toEqual({ users: 0, accounts: 0, sessions: 0 });
  });

  test("rejects an unverified allowed-domain user with the existing UI token", async () => {
    const response = await signIn(
      restricted.auth,
      "google",
      "person@tigerdata.com",
      false,
    );
    expectError(response, "EMAIL_NOT_VERIFIED");
    expect(await counts()).toEqual({ users: 0, accounts: 0, sessions: 0 });
  });

  test("unset accepts a new external user", async () => {
    const response = await signIn(
      unrestricted.auth,
      "github",
      "person@example.com",
    );
    expect((await signedInUser(unrestricted.auth, response)).email).toBe(
      "person@example.com",
    );
    expect(await counts()).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  test("CLI authorization survives a rejected personal GitHub signup and a verified TigerData Google retry", async () => {
    const flow = await startCliAuthorization(restricted.auth);
    const rejected = await signIn(
      restricted.auth,
      "github",
      "personal@example.com",
      true,
      undefined,
      flow.loginURL.search,
    );
    expectError(rejected, "SIGNUP_RESTRICTED:tigerdata.com");
    expect(await counts()).toEqual({ users: 0, accounts: 0, sessions: 0 });
    const retryURL = new URL(rejected.headers.get("Location") ?? "", BASE);
    expect(readSignInError(retryURL.search)).toBe(
      "New registrations are currently limited to verified @tigerdata.com email addresses. Existing users can continue to sign in.",
    );
    const search = clearSignInError(retryURL.search);
    expect(search).toBe(flow.loginURL.search);
    const signedIn = await signIn(
      restricted.auth,
      "google",
      "employee@tigerdata.com",
      true,
      undefined,
      retryURL.search,
    );

    // Authorize also accepts unsigned requests; exercise the signed-query verifier.
    const checked = await restricted.auth.api.oauth2Consent({
      headers: new Headers({ Cookie: cookies(signedIn) }),
      body: { accept: false, oauth_query: search },
    });
    expect(new URL(checked.url).searchParams.get("error")).toBe(
      "access_denied",
    );

    const tokens = await exchangeCliCode(restricted.auth, flow, signedIn);
    expect(
      await restricted.verifyOAuthAccessToken(tokens.access_token),
    ).toMatchObject({
      email: "employee@tigerdata.com",
      emailVerified: true,
    });
  });

  test("an external user's OAuth refresh token remains valid after signup is restricted", async () => {
    const flow = await startCliAuthorization(unrestricted.auth);
    const signedIn = await signIn(
      unrestricted.auth,
      "github",
      "existing@example.com",
      true,
      undefined,
      flow.loginURL.search,
    );
    const tokens = await exchangeCliCode(unrestricted.auth, flow, signedIn);
    const original = await unrestricted.verifyOAuthAccessToken(
      tokens.access_token,
    );
    expect(original).toMatchObject({ email: "existing@example.com" });

    const refreshed = await requestTokens(restricted.auth, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(
      await restricted.verifyOAuthAccessToken(refreshed.access_token),
    ).toEqual(original);
    expect(await counts()).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  test("existing external auth-only user signs in, links a second verified provider, and tolerates a changed provider email", async () => {
    // No core principal or space: auth.users alone defines an existing user.
    const accountId = crypto.randomUUID();
    const first = await signIn(
      unrestricted.auth,
      "github",
      "existing@example.com",
      true,
      accountId,
    );
    const original = await signedInUser(unrestricted.auth, first);
    const again = await signIn(
      restricted.auth,
      "github",
      "existing@example.com",
      true,
      accountId,
    );
    expect((await signedInUser(restricted.auth, again)).id).toBe(original.id);

    const linked = await signIn(
      restricted.auth,
      "google",
      "existing@example.com",
    );
    expect((await signedInUser(restricted.auth, linked)).id).toBe(original.id);

    const changed = await signIn(
      restricted.auth,
      "github",
      "changed@external.test",
      true,
      accountId,
    );
    const user = await signedInUser(restricted.auth, changed);
    expect(user.id).toBe(original.id);
    expect(user.email).toBe("existing@example.com");
    expect(await counts()).toEqual({ users: 1, accounts: 2, sessions: 4 });
  });

  test("an existing external auth row without an account can safely link its first provider", async () => {
    const [existing] = await sql.unsafe(
      `insert into ${authSchema}.users (name, email, email_verified) values ('Existing', 'existing@example.com', true) returning id`,
    );
    const response = await signIn(
      restricted.auth,
      "google",
      "existing@example.com",
    );
    expect((await signedInUser(restricted.auth, response)).id).toBe(
      existing?.id,
    );
    expect(await counts()).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  test("does not bypass safe account linking for an unverified second provider", async () => {
    await signIn(unrestricted.auth, "github", "existing@example.com");
    const response = await signIn(
      restricted.auth,
      "google",
      "existing@example.com",
      false,
    );
    expectError(response, "account_not_linked");
    expect(await counts()).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  test("unset preserves the existing session verification gate and its human error", async () => {
    const response = await signIn(
      unrestricted.auth,
      "github",
      "unverified@example.com",
      false,
    );
    expectError(response, "EMAIL_NOT_VERIFIED");
    const location = new URL(response.headers.get("Location") ?? "", BASE);
    expect(location.searchParams.get("error_description")).toBe(
      "Your email is not verified with your identity provider. Verify it with GitHub or Google, then sign in again.",
    );
    expect(await counts()).toEqual({ users: 1, accounts: 1, sessions: 0 });
  });
});
