# Plan: Re-add device-flow login

Add OAuth 2.0 Device Authorization Grant (RFC 8628) login back to the `me` CLI,
**in addition to** the existing OAuth 2.1 authorization-code + PKCE loopback
flow. Motivation: agent harnesses often run in headless sandboxes with no
browser, where the loopback flow can't complete.

## Approach

Enable better-auth 1.6.20's built-in `device-authorization` plugin (installed on
disk, not currently enabled) plus the `bearer` plugin. Device login yields a
**better-auth session token** (7-day sliding session, **no** refresh token) — the
plugin issues `session.token` via `createSession`, not an OAuth access/refresh
pair. The CLI stores that token in the existing `OAuthTokenSet.access_token`
slot; the resource-server middleware learns to accept a session-token bearer via
`getSession` (the `bearer` plugin converts `Authorization: Bearer <token>` into a
session lookup, which also gives sliding refresh for free). All endpoints ride
the existing `/api/v1/auth/*` catch-all — no new server routes.

### Decisions (confirmed)

- **Token model**: better-auth session token (least code; rides the maintained
  plugin). Tradeoff: no refresh token — a 7-day sliding session, re-login if idle
  > 7 days.
- **Trigger**: explicit `me login --device` flag (no behavior change for existing
  users).
- **Web page**: full `/device` verification page now.

## Step 1 — Database (`packages/database/auth/migrate/`)

- **New** `incremental/007_device_code.sql`: create snake_case
  `device_code` table matching the plugin's `deviceCode` model (`id`,
  `device_code`, `user_code`, `user_id`, `expires_at`, `status`,
  `last_polled_at`, `polling_interval`, `client_id`, `scope`) + unique indexes on
  `user_code`/`device_code` and an `expires_at` index for sweeps. Mirrors the
  006 conventions: `id text primary key default (uuidv7()::text)`, FK columns to
  uuid PKs are `uuid`.
- **New** `idempotent/006_device.sql`: `cleanup_expired_device_codes()` sweep
  (plain `create or replace`, matching sibling cleanup functions).
- Register both in `migrate.ts` (imports + `incrementals`/`idempotents` arrays).
- Update `migrate.integration.test.ts`: add `device_code` to `EXPECTED_TABLES` +
  `EXPECTED_COLUMNS`,   `007_device_code` to `EXPECTED_MIGRATIONS`,
  `cleanup_expired_device_codes` to `EXPECTED_FUNCTIONS`.

## Step 2 — Server (`packages/server`)

- `auth/betterauth.ts`: add `deviceAuthorization({ verificationUri:
  \`${baseURL}/device\`, validateClient: id => id === CLI_CLIENT_ID, expiresIn,
  interval, schema: { deviceCode: { modelName: "device_code", fields: {...} } } })`
  and `bearer()` to the plugins array.
- `middleware/authenticate-user.ts` and `middleware/authenticate-space.ts`: after
  `verifyOAuthToken` fails on a bearer, fall through to
  `betterAuth.api.getSession({ headers })` (bearer plugin resolves the session
  token); on a hit map to `kind:"u"`. Stays in the bearer path (non-ambient — no
  CSRF gate, same as api keys/OAuth).
- `auth/cleanup.ts`: add `cleanup_expired_device_codes()` to the sweep + a count
  field (legacy `DEVICE_FLOW_CLEANUP_CRON` env is already honored).

## Step 3 — Web (`packages/web`)

- New `/device` verification page (`components/DeviceVerificationPage.tsx`,
  routed in `main.tsx`, hosted-only like `/login`): probes the session via
  `whoami`, reuses `SignInCard` for anonymous visitors (OAuth returns to the
  same URL with `user_code` preserved), reads `?user_code=` (or prompts for it),
  claims via `GET /device`, then approve/deny with success/denied states. It
  calls the better-auth device endpoints directly with same-origin
  cookie-authenticated `fetch` (`GET /device`, `POST /device/approve`,
  `POST /device/deny`) rather than the generated client plugin — no dependency
  on the plugin's generated method shape.

## Step 4 — CLI (`packages/cli`) ✅

- `commands/login.ts`: added `--device` and `--no-browser`; the action branches
  into `authorizeViaDevice` vs `authorizeViaLoopback` (the loopback path was
  extracted into its own helper). The post-auth code (storeTokens → whoami →
  space selection → output) is shared.
- New `device.ts`: `startDeviceAuthorization` (`POST /api/v1/auth/device/code`)
  and `pollDeviceToken` (`POST /api/v1/auth/device/token`), a plain-`fetch`
  poller respecting `interval`/`slow_down` and handling `authorization_pending` /
  `access_denied` / `expired_token` / timeout. (Plain fetch, not `openid-client`,
  because better-auth's device endpoints aren't the standard `token_endpoint`.)
  `sleep` is injectable for tests.
- Device login prints the verification URL + code (text mode; opens a browser
  unless `--no-browser`) or emits them as JSON on stderr (structured modes),
  then stores the session token via `storeTokens` with **no** `refresh_token` —
  `session.ts` already treats a missing refresh token as "re-login when it
  lapses" (and the session slides server-side on use meanwhile). No change to
  `session.ts` / `util.ts` / transport.
- Tests: `device.test.ts` covers the poller (pending→approve, slow_down,
  denied, expired, timeout, unexpected error) and code-request parsing.

## Step 5 — Docs & tests

- Fix stale "device flow" wording that actually means the loopback flow
  (`scripts/integration-test.ts`, `docs/getting-started.md`,
  `docs/cli/me-login.md`, `docs/typescript-client.md`); document the real device
  flow in `docs/cli/me-login.md`.
- Tests: server device integration test (code → claim → approve → token → bearer
  validates on both RPCs; deny/expiry paths); migration drift-test update; CLI
  device poller unit test (interval/slow_down/denied); a `check:full` run.

## Risks / notes

- **No refresh token** by design: sessions slide (`updateAge` 1d / `expiresIn`
  7d) only when used through `getSession` (which the new bearer branch does).
  Idle > 7 days ⇒ re-login. Tunable via `sessions` config for longer headless
  lifetimes.
- Enabling `bearer` adds a `set-auth-token` response header on session-producing
  auth endpoints — cosmetic, low-risk.
- `validateClient` restricts device-code issuance to `me-cli`; the device plugin
  doesn't consult the `oauth_client` table, so no change to the 006 client seed
  is required.
