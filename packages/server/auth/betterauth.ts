// packages/server/auth/betterauth.ts
//
// The better-auth instance. better-auth owns the human identity surface:
// GitHub/Google OAuth, the `users`/`accounts`/`sessions`/`verifications` tables,
// the OAuth 2.0 device flow (CLI login), and session validation. It does NOT
// touch the api-key path (agents) — that stays in `core` (core.validate_api_key).
//
// Design notes (see the migration discussion / CLAUDE.md):
//   * Dedicated pool. better-auth's built-in adapter is Kysely and resolves the
//     auth tables via the connection `search_path`, so it gets its OWN small
//     node-postgres pool pinned to `search_path=<authSchema>`. The main
//     postgres.js app pool (core + me_<slug>) is untouched.
//   * Schema mapping, no renames. We map better-auth's camelCase logical fields
//     onto the existing snake_case / plural tables via `modelName` + `fields`.
//   * DB-generated ids. `advanced.database.generateId: false` lets the column
//     `default uuidv7()` fire (PG18 built-in); the adapter reads it back with
//     `INSERT ... RETURNING`. This keeps `auth.users.id == core.principal.id`.
//   * Session tokens are stored plaintext (better-auth round-trips the token
//     through the row), so the CLI/bearer path is hardened with
//     `bearer({ requireSignature: true })`: a raw DB token is not replayable;
//     a valid bearer credential is the signed `token.signature` value.
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { Pool } from "pg";

/** Path prefix better-auth mounts its routes under (preserves our current URLs). */
export const AUTH_BASE_PATH = "/api/v1/auth";

/** Rolling session window: 7-day lifetime, refreshed at most once/day. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/** Device flow: short-lived user/device codes, RFC 8628 default poll interval. */
const DEVICE_CODE_EXPIRES_IN = "15m";
const DEVICE_POLL_INTERVAL = "5s";

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
  /** Signing secret (BETTER_AUTH_SECRET) for cookie signatures + bearer tokens. */
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
      // CLI/agent transport. requireSignature closes the at-rest replay gap:
      // a raw token read from the DB cannot be replayed; the client must hold
      // the signed `token.signature` value (the `set-auth-token` header value).
      bearer({ requireSignature: true }),
      deviceAuthorization({
        expiresIn: DEVICE_CODE_EXPIRES_IN,
        interval: DEVICE_POLL_INTERVAL,
        // Map the plugin's `deviceCode` model onto our snake_case table.
        schema: {
          deviceCode: {
            modelName: "device_codes",
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

  return { auth, pool };
}

/** The better-auth instance type (inferred from our concrete config). */
export type Auth = ReturnType<typeof createBetterAuth>["auth"];
