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
//      validated by introspection. The CLI no longer uses session tokens.
//
// The api-key path (agents) stays entirely in `core` (core.validate_api_key).
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
import { jwt } from "better-auth/plugins";
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
    ],
    advanced: {
      // Let the DB generate ids (`default uuidv7()`), read back via RETURNING.
      database: { generateId: false },
      cookiePrefix: "me",
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
  async function verifyOAuthAccessToken(
    token: string,
  ): Promise<{ userId: string; scopes: string[] } | null> {
    const { rows } = await pool.query(
      "select user_id, scopes from oauth_access_token where token = $1 and expires_at > now() limit 1",
      [hashOAuthToken(token)],
    );
    const row = rows[0];
    if (!row?.user_id) return null;
    return {
      userId: row.user_id as string,
      scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    };
  }

  return { auth, pool, verifyOAuthAccessToken };
}

/** The better-auth instance type (inferred from our concrete config). */
export type Auth = ReturnType<typeof createBetterAuth>["auth"];

/** Resource-server OAuth access-token validator (from createBetterAuth). */
export type VerifyOAuthAccessToken = ReturnType<
  typeof createBetterAuth
>["verifyOAuthAccessToken"];
