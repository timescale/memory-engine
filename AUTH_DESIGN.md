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

## Credential types

| Caller | Credential | Mechanism | At rest |
|---|---|---|---|
| Human, web UI | session cookie | better-auth social login | session token plaintext in `sessions.token`; cookie is httpOnly |
| Human, CLI (interactive) | OAuth access + refresh token | auth-code + PKCE + loopback | **hashed** (sha256) in `oauth_access_token` / `oauth_refresh_token` |
| Human, headless CLI | **user api key (PAT)** | `core.api_key` for the user's own (`'u'`) principal | **hashed** (sha256) in `core` |
| Agent | api key (`me.<lookupId>.<secret>`) | `core.api_key` for an agent (`'a'`) | **hashed** (sha256) in `core` |

A human can hold several credentials by surface: a cookie for the browser, OAuth
tokens for the interactive CLI (`me login`), and a **personal access token** for
headless/SSH/VM use (`me apikey create --self`). All share one identity
(the `auth.users` / `core.principal` row). A user PAT carries the user's *full*
authority on the data plane but is barred from minting/revoking credentials — see
flow E. (An agent key is the right choice for sandboxes; a user PAT is for "be me,
headless" — see the device-flow vs. PAT note in the alternatives section.)

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
  Auth: OAuth access token (Bearer), cookie, **or the user's own api key (PAT)**.
  An **agent** key is rejected here (403 — agents can't manage the account), and
  `apiKey.create` / `apiKey.delete` reject *any* key-authenticated caller
  (session-only: a key can't mint or revoke keys).
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
  - `userBearer` / `memoryBearer` wire these into the clients. An api key (a user
    PAT on the user RPC, an agent key on the memory RPC) is static (returned as-is,
    never refreshed); the human OAuth token refreshes. Both share the same bearer
    policy — `memoryBearer` delegates to `userBearer`.
- `ME_SESSION_TOKEN` is a raw-bearer override (CI/scripting): returned as-is,
  never refreshed.

**Cross-process refresh races are not deduped — by design.** The dedup is an
in-memory map keyed by server, so it only coalesces concurrent refreshes *within
one process*. Two separate `me` invocations racing on the same rotating refresh
token aren't coordinated (no cross-process file lock). With refresh-token
rotation the loser presents an already-consumed token and gets a 401; it then
falls back to its reactive refresh, or, failing that, to a fresh `me login`. We
accept this: interactive CLI calls are effectively sequential, and the place
concurrency *does* happen — the long-lived `me serve` / `me mcp` processes — is
single-process, where the in-memory dedup applies. A cross-process lock would add
keychain/file-locking complexity for a transient, self-healing reauth.

Long-lived consumers — `me serve` (the `/rpc` proxy) and `me mcp` (the MCP
server) — use the same bearer sources, so they survive access-token expiry
instead of dying after the access-token lifetime.

### E. Api keys (agents + user PATs)

`ME_API_KEY` (`me.<lookupId>.<secret>`) is validated in `core`
(`validate_api_key` → a principal, kind-agnostic). Keys are global per-principal
(not space-bound); the space comes from `X-Me-Space`, gated by
`build_tree_access`. No OAuth, no sessions. The key is printed once by
`apiKey.create` and never persisted by the CLI.

A key can be minted for two kinds of member (`apiKey.create({ memberId })`,
gated by `requireOwnMember` — the caller's own user or an owned agent):

- **Agent key** (kind `'a'`) — a headless service account, scoped to the agent's
  grants. Memory RPC only; rejected on the user RPC.
- **User PAT** (kind `'u'`, the caller's own principal) — "be me, headless"
  (`me apikey create --self`; explicit opt-in, since it's a full-access
  credential). Authenticates as
  the **user** with their full grants, on **both** the memory RPC and the user
  RPC — *except* it cannot mint or revoke keys (`apiKey.create` / `apiKey.delete`
  stay session-only). That carve-out keeps a leaked key from minting a sibling
  to outlive revocation, and matches the PAT norm. `me serve` / `me mcp` accept
  it like any bearer.

Minting/revoking is itself session-only: the user RPC accepts a user PAT for
everything *but* `apiKey.create` / `apiKey.delete`, so keys can't manage keys.

## Provisioning

better-auth owns the `auth.users` + `accounts` rows (written on social login). The
**core** side is stood up lazily and idempotently by `ensureUserProvisioned`
(`packages/server/provision.ts`) on the first authenticated user RPC:

- create `core.principal` (sharing the auth user id) + a default space + its
  `me_<slug>` schema + the creator grants (admin + owner@home + owner@share, not
  owner@root).
- then `redeemInvitationsForVerifiedLogin` — join any spaces this email was
  invited to. It rides every user RPC (better-auth gives no dedicated login
  hook); idempotent + best-effort. **Gated on a provider-verified email**:
  invitations are email-keyed, so an unverified address must not auto-join its
  invited spaces. `emailVerified` is the real `users.email_verified`, carried on
  **all three** credential paths (`verifyOAuthAccessToken` joins it; the cookie
  path reads `session.user.emailVerified`; the api-key path looks it up via
  `getUserEmailVerified`) → the user RPC context → `ensureUserProvisioned`, which
  only redeems when it's true. Because the key path carries the *real* flag (not
  a sentinel), a **user PAT redeems exactly like a session** — a PAT's only
  carve-out is that it can't mint/revoke keys.

**Login gate — a verified email is required to establish a session.** A
`databaseHooks.session.create.before` hook (`betterauth.ts`) throws
`EMAIL_NOT_VERIFIED` unless `users.email_verified` is true, so social sign-in —
and the CLI OAuth flow, which rides the web session — cannot mint a session for
an unverified email. The memory RPC is covered transitively (no session/token →
no bearer), so this is the single front-door chokepoint, no per-endpoint checks.
Agents are unaffected (they authenticate with api keys, never sessions), and
credentials minted while verified keep working. The thrown `APIError` makes the
social callback redirect back to the sign-in page with
`?error=EMAIL_NOT_VERIFIED&error_description=…` (surfaced by `SignInCard`) rather
than 500.

This is the social-login equivalent of better-auth's `requireEmailVerification`,
which we do **not** use: that flag is `emailAndPassword.requireEmailVerification`,
enforced only in the email/password sign-in route (`dist/api/routes/sign-in.mjs`);
the social OAuth callback never consults it (it only persists the provider's
verified-email claim, `dist/oauth2/link-account.mjs`). We're social-only with no
`emailAndPassword` config, so the flag has no surface — the `session.create.before`
hook is where the equivalent lives.

Defense in depth, not the only control: authorization is otherwise principal-id
based, and the one email-keyed step (invitation redemption, above) is *also* gated
on `emailVerified`. That second gate still earns its keep for the edge case of a
PAT that outlives its user's verified status — the key keeps working (it doesn't
re-cross the login gate) but won't redeem while the flag reads false.

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

## Upgrading better-auth (the DB-drift checklist)

better-auth and `@better-auth/oauth-provider` **own DB tables** (`users`,
`sessions`, `accounts`, `verifications`, `oauth_client`, `oauth_access_token`,
`oauth_refresh_token`, `oauth_consent`, `jwks`). A version bump can change the
schema better-auth *expects* — and because our migrations + the snake_case field
mapping in `createBetterAuth` are hand-maintained, that expectation can silently
drift from what the DB actually has, breaking at runtime (or at boot — recall
the `helm --wait --atomic` crashloop in `CLAUDE.md`).

Two guards: the versions are **pinned exactly** (no `^`, in
`packages/server/package.json` + `packages/web/package.json` — same version both
places so the web client matches the server), and the **auth migration test**
(`packages/database/auth/migrate/migrate.integration.test.ts`) asserts the
expected tables / functions / columns, so a schema change that we *haven't*
migrated turns that suite red. Pinning makes the upgrade a deliberate, reviewed
step rather than a transitive surprise.

When bumping `better-auth` / `@better-auth/oauth-provider`, on a branch:

1. **Bump the exact pins** in both `package.json`s (keep them equal) + `./bun install`.
2. **Regenerate the expected schema.** Run better-auth's schema generator
   (`bunx @better-auth/cli generate`) against our configured instance — i.e. the
   `createBetterAuth` config in `packages/server/auth/betterauth.ts` (jwt +
   oauthProvider plugins, the snake_case `modelName`/`fields` mappings) — pointed
   at a throwaway/probe schema. (This is the same tool the initial oauth/jwks DDL
   was derived from.)
3. **Diff** the generated schema against the auth migrations in
   `packages/database/auth/migrate` — look for new/changed tables, columns,
   indexes, or constraints on the owned tables above.
4. For any change, **write a new incremental** (`packages/database/auth/migrate/
   incremental/00N_*.sql`) — never edit a shipped one — and register it in
   `migrate.ts`. (If a change touches one of *our* idempotent SQL functions'
   return types, follow the guarded-drop `42P13` pattern in `CLAUDE.md`;
   better-auth's own tables are plain DDL.)
5. **Reconcile the field mapping.** We map *every* better-auth field explicitly
   via `modelName` + `fields`; a new better-auth field we don't map would be
   queried by its default camelCase name and fail. Add the snake_case mapping (+
   the column in the migration) for any new field.
6. **Run the guards:** `migrate.integration.test.ts` (update its `EXPECTED_*` +
   add column/constraint assertions for new objects), then `./bun run check:full`,
   then **boot the server against an existing DB** (the boot-time idempotent
   migration) to confirm no startup crash.
7. Re-verify the live flows that better-auth owns end-to-end — social `me login`
   + the web login — since they aren't covered headless (see Testing).

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

- **Api keys** — agent keys and user PATs both live in `core` (global,
  sha256-hashed), separate from better-auth. Agent keys are barred from the user
  RPC; user PATs are admitted there but can't manage keys (flow E).
- **Authorization** — the `tree_access` model (read/write/owner grants, the
  `build_tree_access` gate) is unchanged and orthogonal to this document.

## Future: the hosted MCP connector

Not built yet — but the OAuth 2.1 AS above was chosen with this in mind, so this
records the intended path.

Today MCP is **local-only**: `me mcp` runs over stdio and reuses the CLI's
credential (OAuth token or api key). A **hosted** connector would let
third-party AI clients (Claude, ChatGPT, custom agents) connect to a Memory
Engine MCP endpoint over HTTP and authenticate with the standard "Authorize"
UX. Most of the machinery already exists; the delta is small and well-defined.

### Reused unchanged

- The OAuth 2.1 AS: `/oauth2/authorize` + `/oauth2/token`, PKCE, access/refresh
  tokens hashed at rest, the `oauth_client` / `oauth_access_token` /
  `oauth_refresh_token` / `oauth_consent` tables, jwks.
- **Resource-server validation** — `verifyOAuthAccessToken`. An MCP request's
  Bearer token resolves to a user exactly like the CLI's.
- **Authorization** — user → `core.principal` → `tree_access`. Identical: an MCP
  caller is just a user, gated by the same grants. No new authz model (this is
  why "MCP needs scope design" was a non-issue for the basic case).
- **The `/login` page** — the authorize flow's sign-in step is the same.

### The delta from the CLI

`me-cli` is a single, first-party, **trusted + static + public** client with
consent skipped. Hosted MCP clients are **third-party and unknown ahead of
time**, which flips three of those:

1. **Dynamic Client Registration (RFC 7591).** MCP clients register themselves
   at runtime — we can't pre-seed each one like `me-cli`. Enable DCR in the
   `oauthProvider` config; registrations land as `oauth_client` rows (not
   trusted → consent required). This is the DCR we deliberately skipped for the
   CLI — here it earns its keep.
2. **The consent screen.** Untrusted clients must show the user what they're
   granting. `consentPage` is already configured (`${baseURL}/consent`) but the
   page doesn't exist yet — build it like `/login` (a SPA route that reads the
   signed authorize params, renders "<client> wants access to your memories,"
   and approves/denies via the provider's consent endpoint, writing an
   `oauth_consent` row). `me-cli` keeps `skip_consent`; DCR clients don't.
3. **The hosted MCP transport + discovery.** Mount an HTTP/SSE MCP endpoint
   (e.g. `/api/v1/mcp`) using better-auth's MCP support (its `mcp` plugin / MCP
   handler over the OAuth provider). Per the MCP authorization spec, also serve:
   - **Protected Resource Metadata** (RFC 9728) at
     `/.well-known/oauth-protected-resource` — tells clients which AS to use; a
     401 from the MCP endpoint returns `WWW-Authenticate` pointing here.
   - **AS Metadata** (RFC 8414) at `/.well-known/oauth-authorization-server` —
     the better-auth boot warning we already see (`Please ensure
     '/.well-known/oauth-authorization-server/api/v1/auth' exists`) is exactly
     this; surface it so clients can discover authorize/token/registration.
   - **Resource Indicators** (RFC 8707) so an MCP-issued token is audience-bound
     to the connector and can't be replayed against another resource.

### Scopes

The CLI requests coarse access (the user authorizing their own full access — no
scope design needed). Hosted MCP can start the same way (one coarse "full
access" scope) and add granular scopes (read-only, or per-space) when there's a
product reason to let a user grant a third-party client *limited* access. The
MCP spec doesn't mandate fine scopes; design them when the product does.

### Unchanged

- **Agent api keys** (core) — a separate credential for headless agents.
- **Local `me mcp`** (stdio, reusing the CLI credential) stays; the hosted
  connector is additive.
- **`tree_access`** authz.

### Rough build order

1. Build `/consent` (SPA route, mirrors `/login`).
2. Enable DCR in `oauthProvider`; verify a third-party client can
   register → authorize → consent → token.
3. Mount the MCP handler at `/api/v1/mcp` + serve the two `.well-known` metadata
   docs + resource-indicator audience binding.
4. Decide scope granularity (start coarse).
5. e2e: a real MCP client connects, authorizes, and calls a tool.

## Alternatives considered and rejected

The design above was the endpoint of a fairly long debate. The roads not taken,
and why — so they don't get re-litigated:

### Keep the home-grown auth (don't adopt better-auth)

The prior system worked. The push to adopt better-auth was to get a **standard,
audited** identity layer (social login, sessions, an OAuth 2.1 AS) instead of
hand-maintained crypto, and to lay the foundation for a **hosted MCP** connector
(same AS). The main objection was at-rest credential protection (see below);
once that resolved, the standardization + MCP foundation won. **Note we did not
adopt it wholesale** — agent api keys stayed in `core` (next item).

### Move agent api keys into better-auth (e.g. its apiKey plugin)

**Rejected.** Api keys are already global, sha256-hashed, agent-scoped, and wired
into `tree_access` + the space roster in `core`. Moving them buys nothing and
would split the agent model across two schemas. They stay in `core`; better-auth
owns only human identity.

### better-auth **device flow** for the CLI (the original plan)

**Rejected — it doesn't compose.** The plan was the OAuth device-authorization
grant + `bearer({ requireSignature: true })` to harden tokens. But `/device/token`
returns the raw token and emits **no `set-auth-token` header** (better-auth's
bearer header only fires alongside a `set-cookie`), so a CLI could never obtain a
usable signed token. Confirmed by a spike; better-auth discussion #5068 shows
others abandoned the device plugin for the same reason. Device flow is also not
the idiomatic native-app pattern — that's auth-code + PKCE + loopback (RFC 8252).

### better-auth **sessions** as the CLI credential

**Rejected.** better-auth sessions **can't be hashed at rest** (the raw token
round-trips through the session row into the cookie), and the hardening that would
have mitigated it (`requireSignature`) was the very thing incompatible with the
device flow above. Opaque OAuth tokens, by contrast, are **hashed at rest by
default** in `@better-auth/oauth-provider` — which resolved the at-rest concern
that drove the whole debate (net: a real-but-narrow worry, since agent keys are
hashed in `core` regardless and only short-lived web session tokens are plaintext).

### A **confidential** OAuth client for the CLI

**Rejected.** A distributed CLI can't keep a client secret — it would ship in the
binary / sit on every user's disk. The CLI is a **public client** and uses
**PKCE** instead (RFC 8252 / 7636). This also drives the validation choice below.

### **JWT access tokens** (full OIDC, JWKS-verified) for API auth

**Rejected for API auth.** JWT access tokens validated via JWKS make sense when
the resource server is separate from the AS. Here the resource server **shares the
database** with the AS, so **opaque tokens + a hashed DB lookup**
(`verifyOAuthAccessToken`) are simpler, allow instant revocation (delete the row),
and need no key distribution. The `jwt` plugin is still mounted for OIDC id-token
signing (a future hosted-MCP nicety); the CLI omits the `openid` scope, so no
id_token / JWKS is involved in `me login`.

### **RFC 7662 token introspection** for validation

**Rejected.** Introspection (`/oauth2/introspect`) requires a confidential client
to call it — overkill for a resource server co-located with the AS and its
database. The direct hashed lookup is one query and needs no extra client.

### **Dynamic Client Registration** (DCR) for the CLI client

**Rejected.** `me-cli` is a single, first-party, well-known client. A static
seeded `oauth_client` row (migration `006`, marked trusted via
`cachedTrustedClients`) is simpler and lets it skip the consent screen. DCR is
worth revisiting only for third-party / hosted-MCP clients.

### A **hand-rolled** loopback handoff / hand-rolled PKCE in the CLI

**Rejected.** The browser→loopback handoff and PKCE are standardized (RFC 8252 /
7636) and done by every modern CLI; there's no reason to hand-roll the audited
bits (state + `iss` validation, token-response parsing). The CLI uses the
certified **`openid-client`** library with explicit endpoints.

### **Reactive-only** (or proactive-only) CLI token refresh

**Rejected.** Pure reactive-on-401 wastes a guaranteed-401 round-trip on every
expired token and ignores the proactive norm; pure proactive-per-command refreshes
when it needn't. Best practice (gcloud, aws, kubectl-oidc, MSAL) is **proactive
refresh by expiry** (primary) **+ a reactive 401 retry** (safety net for clock
skew / out-of-band revocation), centralized at token acquisition — which is what
`session.ts` + the transport seams implement.

### A **server-rendered HTML** `/login` page

**Rejected.** `packages/web` already exists, is served at root, and `/login`
already falls through to its SPA; the hosted UI needs login anyway (cookie
sessions), and better-auth ships a first-class React client. A bolt-on server HTML
page would be throwaway duplication. `/login` is a route in the existing SPA,
driven by the better-auth SDK.

### A **new** GitHub OAuth app for better-auth

**Not needed.** better-auth's GitHub callback path (`/api/v1/auth/callback/github`)
and env vars (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`) are identical to the prior
design's, so the existing OAuth app carries over unchanged — only update its
callback URL if the deployment domain changes.

### Device flow (RFC 8628) for headless / SSH / VM CLI use

The loopback `me login` can't complete on a headless box (no local browser; the
laptop browser can't reach the VM's `127.0.0.1` callback). Device flow is the
standard fix — and it has a real security edge over the chosen answer: it issues
short-lived + rotating tokens rather than a long-lived static secret.

**Deferred in favor of user PATs + agent keys**, for three reasons:
1. **Not natively supported.** `@better-auth/oauth-provider` implements only
   `authorization_code` / `refresh_token` / `client_credentials` — no device
   grant. better-auth's separate `deviceAuthorization` plugin is *session*-based
   (the rejected path). So device flow would be a custom device-grant endpoint on
   our AS — a real build.
2. **It still needs a human.** The device-code step requires someone to open a
   browser and enter the code, so it can't serve **non-interactive / programmatic**
   contexts (CI, auto-provisioned agent sandboxes) — those need a pre-injected key
   regardless.
3. **User PATs are cheap and cover both.** The `core` api-key layer already keys
   by `member_id` (`'u'|'a'`); allowing the user's own principal was a small
   handler change. A user PAT gives the human's identity headless with zero
   runtime interaction.

Tradeoff accepted: a user PAT is a long-lived, full-(data-plane)-authority static
secret — higher standing blast radius than device flow's short-lived tokens.
Mitigations: it can't manage keys (no self-replication; revocation stays
effective), supports `expiresAt`, and for sandboxes we steer to **scoped agent
keys** rather than a full-authority user PAT. Revisit device flow if interactive
headless-as-yourself becomes common and the short-lived-token posture is worth the
build.
