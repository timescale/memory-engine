# Authentication Design

How Memory Engine authenticates humans and programs. This is the
**authentication** layer (who are you?); **authorization** (what may you touch?)
is the unchanged `tree_access` model summarized in `CLAUDE.md`.

## Overview

Human identity runs on **[better-auth](https://better-auth.com)**, in two roles:

1. **Web identity** — GitHub/Google social login → an httpOnly **cookie session**
   for the web UI.
2. **OAuth 2.1 authorization server** (`@better-auth/oauth-provider`) — issues
   **opaque access + refresh tokens** to OAuth clients. The first client is the
   first-party `me` CLI (a public client doing auth-code + PKCE + loopback); the
   same server is the foundation for a future hosted-MCP connector.

**Agent credentials are NOT better-auth.** Agent **api keys** stay custom in the
`core` schema (`core.api_key`, sha256-hashed, global per-principal). Agents never
touch the OAuth/session machinery.

All auth code lives in `packages/server/auth/` (`betterauth.ts` + `cleanup.ts`),
`packages/cli/` (`oauth.ts`, `oauth-loopback.ts`, `session.ts`, `credentials.ts`),
`packages/client/transport.ts`, and `packages/web/src/` (`api/auth-client.ts` +
the login components).

## Three credential types

| Caller | Credential | Mechanism | At rest |
|---|---|---|---|
| Human, web UI | session cookie | better-auth social login | session token plaintext in `sessions.token`; cookie is httpOnly |
| Human, CLI / programmatic | OAuth access + refresh token | auth-code + PKCE + loopback | **hashed** (sha256) in `oauth_access_token` / `oauth_refresh_token` |
| Agent | api key (`me.<lookupId>.<secret>`) | `core.api_key` | **hashed** (sha256) in `core` — unchanged |

A human therefore has two distinct credentials depending on surface: a cookie for
the browser, OAuth tokens for the CLI. They share one identity (`auth.users` row).

## Data model (the `auth` schema)

One Postgres database, schema `auth` (per `CLAUDE.md`). better-auth's camelCase
models are mapped onto snake_case tables via `modelName` + `fields` in
`createBetterAuth`. `advanced.database.generateId: false` lets the DB generate
`uuidv7()` ids so **`auth.users.id == core.principal.id`** (one identity across
schemas).

Tables (migration `006_betterauth`, on top of `001`–`005`):

- `users`, `accounts`, `verifications` — better-auth identity + social-account
  links + transient verification state.
- `sessions` — better-auth web sessions. A plaintext, unique `token` (not the
  retired `token_hash`) + `updated_at` (adapter-maintained, no DB trigger).
- `oauth_client` — registered OAuth clients. Seeded with **`me-cli`** (see below).
- `oauth_access_token`, `oauth_refresh_token` — issued tokens, stored **hashed**.
- `oauth_consent` — per-(user, client) consent (unused by `me-cli`, which skips
  consent).
- `jwks` — JSON Web Key Set for the `jwt` plugin (id-token signing; private keys
  encrypted with `BETTER_AUTH_SECRET`).

The device-flow tables/functions from the prior design (`device_authorization`,
`create_session`/`poll_device`/…) were dropped in `006`. The `004_device_*`
migration stays in the log (it ran historically); `006` undid its objects.

### The `me-cli` client

Seeded by `006` and treated as immutable + trusted via
`oauthProvider({ cachedTrustedClients })`:

```
client_id      = me-cli
public         = true          # no client secret (PKCE instead)
type           = native
require_pkce    = true
skip_consent   = true          # trusted first-party client → no consent screen
redirect_uris  = ["http://127.0.0.1/callback"]   # loopback; AS ignores the port
grant_types    = ["authorization_code", "refresh_token"]
scopes         = ["openid", "profile", "email", "offline_access"]
```

## Pools & instance

- **App pool** (postgres.js): `auth` + `core` + every `me_<slug>` schema, one
  pool. Used by everything except better-auth's own adapter.
- **Dedicated auth pool** (`node-postgres`/`pg`): better-auth's Kysely adapter
  runs unqualified queries, so it gets its own small pool pinned to
  `search_path=<authSchema>` (`createBetterAuth` builds + returns it; the server
  bootstrap `end()`s it on shutdown). Sized small (`max: 5`) — lookups are cheap.

`createBetterAuth(opts)` (`packages/server/auth/betterauth.ts`) returns
`{ auth, pool, verifyOAuthAccessToken }`:

- `basePath: "/api/v1/auth"`, `cookiePrefix: "me"`, `secret: BETTER_AUTH_SECRET`.
- `socialProviders`: `github` / `google` (each configured only if its
  `*_CLIENT_ID`/`*_CLIENT_SECRET` env is present), with
  `redirectURI = ${baseURL}/api/v1/auth/callback/<provider>`.
- Plugins: `jwt({ disableSettingJwtHeader: true })` + `oauthProvider({ … })`.

## HTTP surface

`packages/server/router.ts`:

- **`/api/v1/auth/*`** → `betterAuth.handler` (method-agnostic catch-all).
  better-auth owns this whole namespace: social sign-in (`/sign-in/social`),
  provider callbacks (`/callback/:provider`), session/sign-out, and the OAuth
  endpoints `/oauth2/authorize` + `/oauth2/token`.
- **`/api/v1/memory/rpc`** — memory data plane + space management. Auth: api key
  **or** OAuth access token (Bearer) **or** cookie; requires `X-Me-Space`.
- **`/api/v1/user/rpc`** — user-scoped (whoami, agent/api-key/space management).
  Auth: OAuth access token (Bearer) **or** cookie. Never an api key.
- **`/`** (any non-`/api` GET) — the web UI (static SPA + fallback), including the
  `/login` page below.

## Flows

### A. Web login (hosted UI)

`packages/web/src/components/AuthGate.tsx` (mounted only in hosted mode):

1. On load, probe the session via the user RPC (`whoami` + `space.list`,
   authenticated by the cookie). 401 → render the login screen.
2. The login screen (`SignInCard`) calls the better-auth React client
   (`packages/web/src/api/auth-client.ts`):
   `authClient.signIn.social({ provider, callbackURL })`.
3. better-auth redirects to GitHub → `/api/v1/auth/callback/github` → sets the
   httpOnly cookie → returns to `callbackURL` (back into the app).
4. Sign-out: `authClient.signOut()`.

The session token never touches JS — it's an httpOnly cookie. Cookie-authenticated
requests pass an Origin-allowlist CSRF gate (`webAllowedOrigins`).

### B. CLI login (`me login`) — auth-code + PKCE + loopback (RFC 6749/7636/8252)

`packages/cli/commands/login.ts`, using `openid-client` (`oauth.ts`) +
`oauth-loopback.ts`:

1. CLI binds an ephemeral `127.0.0.1:<port>` loopback server and opens the browser
   to `${server}/api/v1/auth/oauth2/authorize?client_id=me-cli&redirect_uri=http://127.0.0.1:<port>/callback&code_challenge=<S256>&state=<csrf>&response_type=code&scope=offline_access`.
2. **No session** → the authorize endpoint 302s the browser to the configured
   `loginPage` = `${baseURL}/login`, **with the entire authorize query re-attached
   and HMAC-signed** (`sig` + `exp`, signed with `BETTER_AUTH_SECRET`).
3. `${baseURL}/login` is served by the SPA (`packages/web/src/components/LoginPage.tsx`).
   It signs the user in via `authClient.signIn.social({ provider, callbackURL })`
   where **`callbackURL = /api/v1/auth/oauth2/authorize` + the page's own signed
   query string, verbatim**.
4. GitHub → callback → cookie session set → browser lands back on the authorize
   endpoint with the signed params. better-auth re-validates `sig`/`exp`, sees the
   now-present session, and — `me-cli` is trusted with `skip_consent` — issues an
   **authorization code**, redirecting to the loopback `redirect_uri`
   (`?code&state&iss`).
5. The loopback server captures the callback URL; `openid-client` validates
   `state` + `iss` (RFC 9207) and runs the **PKCE** code exchange at
   `/oauth2/token` → `{ access_token, refresh_token, expires_in }`.
6. The CLI stores the token set (see D).

The loopback redirect is registered without a port (`http://127.0.0.1/callback`);
the AS matches any port for loopback IPs (RFC 8252 §7.3), so the ephemeral port is
free to vary.

### C. Resource-server token validation (the Bearer path)

`packages/server/middleware/authenticate-{space,user}.ts`:

- **Bearer token**:
  - shaped like an api key (`me.<lookupId>.<secret>`) → validated in `core`
    (`core.validate_api_key`). Memory endpoint only.
  - otherwise → an **OAuth access token** → `verifyOAuthToken(token)`.
- **Cookie** (no Bearer) → better-auth `getSession` + the CSRF Origin gate.

`verifyOAuthAccessToken` (in `betterauth.ts`) is the resource-server check: hash
the presented token the same way it was stored (`hashOAuthToken` = sha256 hex) and
look it up on the auth pool:

```sql
select t.user_id, u.email, u.name, t.scopes
  from oauth_access_token t
  join users u on u.id = t.user_id
 where t.token = $1 and t.expires_at > now()
```

Returns `{ userId, email, name, scopes } | null`. Tokens are revoked by row
deletion, so a missing row == invalid — no separate revocation check. The `users`
join means a deleted user's token stops validating immediately.

### D. CLI token lifecycle (storage + refresh)

**Storage** (`packages/cli/credentials.ts`): the `OAuthTokenSet`
(`access_token` + `refresh_token` + `expires_at` + `scope`) is stored in the OS
keychain as JSON (one entry per server origin), or a `0600` file fallback
(`credentials.yaml`) on hosts without a keychain. `resolveCredentials` exposes
`loggedIn` (a stored set or `ME_SESSION_TOKEN` exists) — never a raw token
synchronously. Api keys are never persisted (env-only).

**Refresh — proactive + reactive** (best-practice CLI handling):

- The transport (`packages/client/transport.ts`) gained two seams:
  `getToken` (resolved once per call — **proactive**) and `onUnauthorized`
  (one-shot 401 refresh-and-retry, off the retry budget — **reactive**).
- `packages/cli/session.ts` implements them:
  - `getAccessToken(server)` — return the stored access token, but refresh first
    if it is expired or within a 60s clock-skew buffer.
  - `refreshAccessToken(server)` — forced refresh after a 401.
  - Refresh-token **rotation** is honored (persist the new refresh token), and
    concurrent refreshes are **deduped** per server (so long-lived `me serve` /
    `me mcp` don't race the rotating token).
  - `userBearer` / `memoryBearer` wire these into the clients. An agent api key is
    static (returned as-is, never refreshed); the human OAuth token refreshes.
- `ME_SESSION_TOKEN` is a raw-bearer override (CI/scripting): returned as-is,
  never refreshed.

Long-lived consumers — `me serve` (the `/rpc` proxy) and `me mcp` (the MCP
server) — use the same bearer sources, so they survive access-token expiry
instead of dying after the access-token lifetime.

### E. Agent api keys (unchanged)

Agents present `ME_API_KEY` (`me.<lookupId>.<secret>`), validated in `core`. Keys
are global per-principal (not space-bound); the space comes from `X-Me-Space`,
gated by `build_tree_access`. No OAuth, no sessions. `apiKey.create` prints the
key once; it is never persisted by the CLI.

## Provisioning

better-auth owns the `auth.users` + `accounts` rows (written on social login). The
**core** side is stood up lazily and idempotently by `ensureUserProvisioned`
(`packages/server/provision.ts`) on the first authenticated user RPC:

- create `core.principal` (sharing the auth user id) + a default space + its
  `me_<slug>` schema + the creator grants (admin + owner@home + owner@share, not
  owner@root).
- then `redeemInvitationsForVerifiedLogin` — join any spaces this (provider-
  verified) email was invited to. It rides every user RPC (better-auth gives no
  dedicated login hook); idempotent + best-effort.

## Cleanup

better-auth + the OAuth provider own their tables but don't purge expired rows, so
the server runs a cron (`packages/server/auth/cleanup.ts` `cleanupExpiredAuth`) on
the app pool, calling the schema's SQL sweeps: `cleanup_expired_sessions`,
`cleanup_expired_verifications`, `cleanup_expired_oauth_tokens` (access + refresh).

## Security properties

- **PKCE** (S256) for the CLI public client — no client secret on disk; an
  intercepted auth code is useless without the verifier.
- **Tokens hashed at rest**: OAuth access + refresh tokens are sha256-hashed in
  the DB (`oauthProvider({ storeTokens: { hash } })` + the matching
  resource-server hash), as are agent api keys (in `core`). Only short-lived web
  **session** tokens are plaintext (httpOnly cookie + the `BETTER_AUTH_SECRET`
  signs cookies / encrypts jwks).
- **Signed `loginPage` handoff**: the authorize→`/login` redirect carries the full
  request HMAC-signed (`sig`/`exp`), so the login page can't be used to smuggle a
  tampered authorize request back to the AS.
- **Loopback redirect** (RFC 8252) for the CLI — no token ever leaves the local
  machine over the network during the handoff.
- **CSRF**: cookie-authenticated requests pass an Origin-allowlist gate;
  Bearer/api-key requests don't need it.

## Configuration

Server env:

- `BETTER_AUTH_SECRET` — **required**; cookie signatures + jwks key encryption +
  the `loginPage` handoff signature.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (and/or `GOOGLE_*`) — social login.
  The GitHub OAuth app's Authorization callback URL must be
  `${baseURL}/api/v1/auth/callback/github` (unchanged from the prior design — the
  same app + callback path carries over; only update it if the domain changes).
- `API_BASE_URL` — `baseURL` for cookies + OAuth callbacks + the issuer
  (`${baseURL}/api/v1/auth`).

CLI env: `ME_SERVER`, `ME_API_KEY`, `ME_SPACE`, `ME_SESSION_TOKEN` (raw-bearer
override), `ME_NO_KEYCHAIN`.

## Testing

- **Unit** (`./bun run check`): transport refresh seams, credential token-set
  storage, the `session.ts` refresh/rotation/dedup logic, the loopback handler,
  the web build.
- **Integration** (`./bun run test:db`): `verifyOAuthAccessToken` + the Bearer
  dispatch (`authenticate-space`), lazy provisioning + invitation redemption, the
  cleanup sweep, and the auth migration shape. Tests mint a real OAuth bearer by
  inserting an `oauth_access_token` row (`seedUserSpace` with `auth`) — there is no
  hand-rolled session faking.
- **e2e** (`e2e/cli.e2e.test.ts`): the real `me` CLI subprocess against a real
  server + DB + OpenAI embeddings, on the OAuth access-token bearer (token
  injection). It deliberately bypasses the browser `me login`; the GitHub
  round-trip is verified live.

## What is intentionally NOT better-auth

- **Agent api keys** — stay in `core` (global, sha256-hashed). Agents can't manage
  agents, so the user RPC rejects api keys entirely.
- **Authorization** — the `tree_access` model (read/write/owner grants, the
  `build_tree_access` gate) is unchanged and orthogonal to this document.
