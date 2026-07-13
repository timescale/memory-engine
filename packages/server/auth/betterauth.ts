// packages/server/auth/betterauth.ts
//
// The better-auth instance. It plays two roles:
//
//   1. Web identity: GitHub/Google social login → cookie sessions for the web UI
//      (the `users`/`accounts`/`sessions`/`verifications` tables). This is also
//      the login step the OAuth authorize endpoint relies on.
//   2. OAuth 2.1 authorization server (`oauthProvider`): issues access/refresh
//      tokens to OAuth clients — the first being the first-party `me` CLI (a
//      public client doing auth-code + PKCE + loopback), and later hosted-MCP
//      clients. Tokens are opaque and HASHED at rest by default (storeTokens),
//      validated by introspection.
//   3. Device Authorization Grant (`deviceAuthorization` + `bearer` plugins):
//      the headless CLI path (RFC 8628) for sandboxes with no browser. Unlike
//      the auth-code flow it mints a better-auth SESSION (no refresh token),
//      presented back as a signed bearer session token — hence the `bearer`
//      plugin.
//
// The api-key path (agents) stays entirely in `core` (core.validate_api_key).
//
// UPGRADING better-auth: the versions here are pinned EXACTLY (no `^`) because
// better-auth owns DB tables — a bump can change the schema it expects and drift
// from our hand-maintained migrations + the field mapping below. Follow the
// regenerate→diff→migrate checklist in AUTH_DESIGN.md ("Upgrading better-auth")
// before bumping; the auth migration test is the drift guard.
//
// Design notes (see the migration discussion / CLAUDE.md):
//   * Dedicated pool. better-auth's adapter is Kysely and resolves the auth
//     tables via the connection `search_path`, so it gets its OWN small
//     node-postgres pool pinned to `search_path=<authSchema>`. The main
//     postgres.js app pool (core + me_<slug>) is untouched.
//   * Schema mapping. Every table is snake_case (house style), mapped onto
//     better-auth's camelCase models via `modelName`+`fields` — the pre-existing
//     user/session/account/verification tables and the new OAuth-provider + jwks
//     tables alike. Single-word fields keep their name. The migration creates
//     matching DDL.
//   * DB-generated ids. `advanced.database.generateId: false` lets `default
//     uuidv7()` fire (PG18 built-in), read back via RETURNING — keeps
//     `auth.users.id == core.principal.id`.

import { createHash } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization, jwt } from "better-auth/plugins";
import { Pool } from "pg";

/** Path prefix better-auth mounts its routes under (preserves our current URLs). */
export const AUTH_BASE_PATH = "/api/v1/auth";

/**
 * client_id of the first-party `me` CLI — a trusted public OAuth client
 * (PKCE + loopback redirect, consent skipped). Registered as a row in the
 * oauth client table by the migration; listed here so the provider treats it as
 * an immutable trusted client and so the CLI can reference it.
 */
export const CLI_CLIENT_ID = "me-cli";

/** Rolling web-session window: 7-day lifetime, refreshed at most once/day. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * Device Authorization Grant (RFC 8628) timing: how long a device/user code is
 * valid, and the minimum interval the CLI must wait between polls. Short TTL —
 * the human is expected to approve within minutes.
 */
const DEVICE_CODE_EXPIRES_IN = "15m";
const DEVICE_CODE_POLL_INTERVAL = "5s";

/** Per-IP cap for unauthenticated device-code issuance. */
const DEVICE_CODE_RATE_WINDOW_SECONDS = 60;
const DEVICE_CODE_RATE_MAX = 10;

/**
 * Deterministic at-rest hash for OAuth access/refresh tokens. Used BOTH as the
 * provider's `storeTokens` hasher (so tokens are stored hashed) AND by the
 * resource-server lookup below (hash the presented token, find its row) — one
 * source of truth. sha256 hex, matching the core api-key convention.
 */
function hashOAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface OAuthProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface BetterAuthOptions {
  /** Connection string for the auth pool (same DB as the app pool). */
  databaseUrl: string;
  /** Postgres schema holding the auth tables. Default "auth". */
  authSchema: string;
  /** Public base URL (API_BASE_URL); used for baseURL + OAuth callbacks. */
  baseURL: string;
  /** Signing secret (BETTER_AUTH_SECRET): cookie signatures + jwks key encryption. */
  secret: string;
  /** Origins allowed to drive the browser flow (CSRF). */
  trustedOrigins: string[];
  /** GitHub OAuth app credentials, if configured. */
  github?: OAuthProviderCredentials;
  /** Google OAuth app credentials, if configured. */
  google?: OAuthProviderCredentials;
  /** Max connections for the dedicated auth pool. Default 5 (lookups are cheap). */
  poolMax?: number;
  /**
   * Override better-auth's rate-limit enabled flag. Undefined preserves its
   * default behavior: enabled in production, disabled in development/test.
   */
  rateLimitEnabled?: boolean;
}

/**
 * Build the better-auth instance + its dedicated, schema-pinned pool.
 *
 * The pool is returned so the server bootstrap can `end()` it on shutdown
 * alongside the other pools.
 */
export function createBetterAuth(opts: BetterAuthOptions) {
  const secure = new URL(opts.baseURL).protocol === "https:";

  // Dedicated auth pool, pinned to the auth schema via the libpq `options`
  // startup parameter so better-auth's unqualified Kysely queries resolve there.
  const pool = new Pool({
    connectionString: opts.databaseUrl,
    max: opts.poolMax ?? 5,
    options: `-c search_path=${opts.authSchema}`,
    application_name: "me-auth",
  });

  const auth = betterAuth({
    // better-auth wraps a raw pg Pool in Kysely's PostgresDialect itself.
    database: pool,
    baseURL: opts.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: opts.secret,
    trustedOrigins: opts.trustedOrigins,
    rateLimit: {
      enabled: opts.rateLimitEnabled,
      customRules: {
        "/device/code": {
          window: DEVICE_CODE_RATE_WINDOW_SECONDS,
          max: DEVICE_CODE_RATE_MAX,
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Gate login on a provider-verified email — the single front-door
          // chokepoint. Social sign-in creates the session here, and the CLI's
          // OAuth flow is built on that web session, so blocking it blocks both;
          // the memory RPC is covered transitively (no session/token → no
          // bearer). Agents never reach this (they use api keys, not sessions),
          // and credentials minted while verified keep working. `email_verified`
          // is the provider's claim (GitHub/Google only release a verified
          // email), re-read on every login. Throwing an APIError makes the
          // social callback redirect to the error URL (see AUTH_DESIGN flows
          // A/B) rather than 500.
          before: async (session) => {
            if (!(await getUserEmailVerified(session.userId))) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message:
                  "Your email is not verified with your identity provider. Verify it with GitHub or Google, then sign in again.",
              });
            }
          },
        },
      },
    },
    socialProviders: {
      ...(opts.github
        ? {
            github: {
              clientId: opts.github.clientId,
              clientSecret: opts.github.clientSecret,
              redirectURI: `${opts.baseURL}${AUTH_BASE_PATH}/callback/github`,
            },
          }
        : {}),
      ...(opts.google
        ? {
            google: {
              clientId: opts.google.clientId,
              clientSecret: opts.google.clientSecret,
              redirectURI: `${opts.baseURL}${AUTH_BASE_PATH}/callback/google`,
            },
          }
        : {}),
    },
    plugins: [
      // Signs OIDC id tokens + exposes JWKS; private keys stored encrypted with
      // `secret`. Opaque access tokens are validated by introspection, not JWKS.
      // disableSettingJwtHeader: recommended alongside an OAuth provider (session
      // payloads aren't signed into a header). jwks table mapped to snake_case.
      jwt({
        disableSettingJwtHeader: true,
        schema: {
          jwks: {
            modelName: "jwks",
            fields: {
              publicKey: "public_key",
              privateKey: "private_key",
              createdAt: "created_at",
              expiresAt: "expires_at",
            },
          },
        },
      }),
      // OAuth 2.1 authorization server. Access/refresh tokens default to
      // `storeTokens: "hashed"` (sha256 at rest, hash-on-lookup). The CLI is a
      // trusted public client; cachedTrustedClients makes it immutable via the
      // CRUD/registration endpoints and lets it skip the consent screen. The
      // tables are mapped to snake_case (single-word fields keep their name).
      oauthProvider({
        loginPage: `${opts.baseURL}/login`,
        consentPage: `${opts.baseURL}/consent`,
        cachedTrustedClients: new Set([CLI_CLIENT_ID]),
        // Control the at-rest hash so verifyOAuthAccessToken can look tokens up.
        storeTokens: { hash: (token) => hashOAuthToken(token) },
        schema: {
          oauthClient: {
            modelName: "oauth_client",
            fields: {
              clientId: "client_id",
              clientSecret: "client_secret",
              skipConsent: "skip_consent",
              enableEndSession: "enable_end_session",
              subjectType: "subject_type",
              userId: "user_id",
              createdAt: "created_at",
              updatedAt: "updated_at",
              softwareId: "software_id",
              softwareVersion: "software_version",
              softwareStatement: "software_statement",
              redirectUris: "redirect_uris",
              postLogoutRedirectUris: "post_logout_redirect_uris",
              tokenEndpointAuthMethod: "token_endpoint_auth_method",
              grantTypes: "grant_types",
              responseTypes: "response_types",
              requirePKCE: "require_pkce",
              referenceId: "reference_id",
            },
          },
          oauthAccessToken: {
            modelName: "oauth_access_token",
            fields: {
              clientId: "client_id",
              sessionId: "session_id",
              userId: "user_id",
              referenceId: "reference_id",
              refreshId: "refresh_id",
              expiresAt: "expires_at",
              createdAt: "created_at",
            },
          },
          oauthRefreshToken: {
            modelName: "oauth_refresh_token",
            fields: {
              clientId: "client_id",
              sessionId: "session_id",
              userId: "user_id",
              referenceId: "reference_id",
              expiresAt: "expires_at",
              createdAt: "created_at",
              authTime: "auth_time",
            },
          },
          oauthConsent: {
            modelName: "oauth_consent",
            fields: {
              clientId: "client_id",
              userId: "user_id",
              referenceId: "reference_id",
              createdAt: "created_at",
              updatedAt: "updated_at",
            },
          },
        },
      }),
      // Device Authorization Grant (RFC 8628): lets a headless CLI (an agent
      // harness in a sandbox with no browser) log in — the CLI polls with a
      // device_code while the human approves the paired user_code at the web
      // `/device` page. On approval the plugin mints a normal better-auth SESSION
      // (via internalAdapter.createSession, so the verified-email hook above still
      // gates it) — NOT an OAuth token, so there is no refresh token; the session
      // slides on use. The resulting signed session token is accepted as a bearer
      // by the `bearer` plugin below. `validateClient` restricts code issuance to
      // the first-party CLI. Code issuance is also rate-limited by better-auth's
      // per-IP limiter (10/min on /device/code). We intentionally keep the
      // default memory backend: the cap is per process/pod and resets on restart,
      // but it still bounds unauthenticated row/WAL amplification without adding
      // another database write to every auth request. The key uses better-auth's
      // default client-IP extraction (x-forwarded-for[0]), so the ingress must
      // provide a trustworthy XFF value. `verificationUri` points at the web page
      // (same origin as the API). The `deviceCode` model is mapped to the
      // snake_case device_code table (single-word fields status/scope keep their
      // name).
      deviceAuthorization({
        expiresIn: DEVICE_CODE_EXPIRES_IN,
        interval: DEVICE_CODE_POLL_INTERVAL,
        verificationUri: `${opts.baseURL}/device`,
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
        schema: {
          deviceCode: {
            modelName: "device_code",
            fields: {
              deviceCode: "device_code",
              userCode: "user_code",
              userId: "user_id",
              expiresAt: "expires_at",
              lastPolledAt: "last_polled_at",
              pollingInterval: "polling_interval",
              clientId: "client_id",
            },
          },
        },
      }),
      // Accept only SIGNED better-auth session tokens presented as
      // `Authorization: Bearer <token>` (converted to a session lookup via
      // getSession). The device-token handler below rewrites the plugin's raw
      // `session.token` JSON response to the signed cookie-equivalent value, so
      // CLI device credentials work while plaintext auth.sessions.token values
      // from a DB/backup disclosure do not authenticate as API bearers.
      bearer({ requireSignature: true }),
    ],
    advanced: {
      // Let the DB generate ids (`default uuidv7()`), read back via RETURNING.
      database: { generateId: false },
      cookiePrefix: "me",
      // On HTTPS, better-auth names cookies `__Secure-me.*`. It has no `__Host-`
      // option (its cookie namer only emits `__Secure-` or none, and the
      // standalone `getSessionCookie` reader looks only for `__Secure-`/bare), so
      // we can't get the browser-enforced `__Host-` assertion without overriding
      // the name — which the reader wouldn't find. The cookies already have the
      // `__Host-` *properties* (Secure, Path=/, no Domain — we don't enable
      // crossSubDomainCookies); combined with SameSite=Lax + the Origin CSRF gate
      // this is sufficient. Revisit if better-auth adds `__Host-` support.
      useSecureCookies: secure,
    },
    // Map better-auth's logical models onto the existing snake_case tables.
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      modelName: "sessions",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        userId: "user_id",
        providerId: "provider_id",
        accountId: "account_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
  });

  /**
   * Resource-server validation for an OAuth access token (the CLI/MCP bearer).
   * Hash it the same way it was stored and look it up in oauth_access_token on
   * the auth pool (search_path=auth). Returns the bound user + granted scopes,
   * or null if unknown/expired. Access tokens are revoked by row deletion, so a
   * missing row == invalid — no extra revocation check needed.
   */
  async function verifyOAuthAccessToken(token: string): Promise<{
    userId: string;
    email: string;
    name: string;
    /** Whether the identity provider verified the email — gates email-keyed ops. */
    emailVerified: boolean;
    scopes: string[];
  } | null> {
    // Join the user so callers get identity (whoami / provisioning) in one hop.
    // A user-less token (client_credentials) yields no row → treated as invalid;
    // our API auth is user-bound (agents use core api keys, not OAuth).
    const { rows } = await pool.query(
      `select t.user_id, u.email, u.name, u.email_verified, t.scopes
         from oauth_access_token t
         join users u on u.id = t.user_id
        where t.token = $1 and t.expires_at > now()
        limit 1`,
      [hashOAuthToken(token)],
    );
    const row = rows[0];
    if (!row?.user_id) return null;
    return {
      userId: row.user_id as string,
      email: row.email as string,
      name: row.name as string,
      emailVerified: Boolean(row.email_verified),
      scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    };
  }

  /**
   * Current email-verified flag for a user id — the same fact the cookie/OAuth
   * paths carry (`users.email_verified`). The api-key (PAT) path resolves a
   * principal but doesn't otherwise touch the auth schema, so it uses this to
   * report an honest `emailVerified` rather than a sentinel. Defaults to false
   * for a missing user (fail-closed for the email-keyed redemption gate).
   */
  async function getUserEmailVerified(userId: string): Promise<boolean> {
    const { rows } = await pool.query(
      `select email_verified from users where id = $1 limit 1`,
      [userId],
    );
    return Boolean(rows[0]?.email_verified);
  }

  return { auth, pool, verifyOAuthAccessToken, getUserEmailVerified };
}

/** The better-auth instance type (inferred from our concrete config). */
export type Auth = ReturnType<typeof createBetterAuth>["auth"];

/** Resource-server OAuth access-token validator (from createBetterAuth). */
export type VerifyOAuthAccessToken = ReturnType<
  typeof createBetterAuth
>["verifyOAuthAccessToken"];

/** Current `email_verified` for a user id (from createBetterAuth). */
export type GetUserEmailVerified = ReturnType<
  typeof createBetterAuth
>["getUserEmailVerified"];

function isDeviceTokenRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    request.method === "POST" &&
    url.pathname === `${AUTH_BASE_PATH}/device/token`
  );
}

function deviceTokenSigningFailure(): Response {
  return Response.json(
    {
      error: "server_error",
      error_description: "Failed to sign device session token.",
    },
    {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

export async function signSessionTokenForBearer(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return encodeURIComponent(`${token}.${signature}`);
}

/**
 * better-auth's device plugin returns the raw DB session token in JSON. Our
 * resource-server bearer path requires the signed cookie-equivalent form, so
 * rewrite only the successful `/device/token` response body to keep
 * `access_token` usable without accepting plaintext `auth.sessions.token` values
 * globally.
 */
export async function handleBetterAuthRequest(
  auth: Auth,
  request: Request,
): Promise<Response> {
  const response = await auth.handler(request);
  if (!response.ok || !isDeviceTokenRequest(request)) return response;

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body.access_token !== "string") {
    return deviceTokenSigningFailure();
  }

  const ctx = await auth.$context;
  const signedToken = await signSessionTokenForBearer(
    body.access_token,
    ctx.secret,
  );

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");

  return new Response(
    JSON.stringify({
      ...body,
      access_token: signedToken,
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}
