---
title: Authentication
tags: [authentication, oauth, sessions, api-keys, device-flow]
---

# Authentication

Authentication establishes the credential holder's identity. Authorization then
decides what that identity may do: the user endpoint applies its method-level
rules, while the memory endpoint additionally requires direct membership in the
selected space and passes effective tree grants to the data plane. API keys are
described in more detail in [Restricted API Keys](restricted-api-keys.md).

## Credential classes

| Credential | Holder | Primary use | Validation |
| --- | --- | --- | --- |
| Browser session cookie | User | Hosted web UI | better-auth session lookup |
| OAuth access token | User | CLI and MCP | Hashed token lookup in the auth schema |
| Signed session bearer | User | `me login --device` | better-auth bearer plugin session lookup |
| API key | User or service account | Headless automation and explicit key use | Core API-key validation |

Human identity and OAuth issuance use better-auth. API keys remain in the core
control plane, so service accounts never need a social-login identity. A bearer
is classified by its `me.<lookup-id>.<secret>` structure: a matching value is an
API key; every other bearer is tried as an OAuth access token and then as a
signed session bearer. This explicit dispatch prevents a cookie from being
mistaken for an API key.

## Web sessions

GitHub and Google social login create better-auth sessions. A provider-verified
email is required before a session is created. This is the human-login front
door: OAuth authorization and device approval both depend on a valid web
session, so they inherit the same verification requirement.

Sessions have a seven-day rolling lifetime and refresh at most daily. They are
stored in the auth schema because better-auth needs to round-trip the session
token. HTTPS deployments use secure, same-site cookies; browser requests using
the ambient cookie must also pass the server's allowed-origin check. A supplied
Bearer credential is never allowed to fall back to a cookie session, so an
invalid bearer cannot bypass that CSRF boundary.

## New-user signup restriction

`SIGNUP_EMAIL_DOMAIN` optionally restricts new human accounts to a single email
domain. Unset preserves unrestricted self-hosted signup; the hosted Helm chart
sets `tigerdata.com`. Explicit values are validated at startup and normalized
for case and surrounding whitespace; empty or malformed values fail startup.

The `user.create.before` database hook in `packages/server/auth/betterauth.ts`
requires an exact domain match and a provider-verified email before any user or
linked account is saved. It uses the email the provider already selects, not
all addresses attached to a GitHub account. Subdomains and lookalike suffixes
are not matches. Invitation links still require this same signup step.

Existing means an `auth.users` record, even without a core principal or space.
Existing-user sign-in and safe provider-account linking do not create users and
remain unchanged. The restriction does not run during session creation, token
refresh, API-key validation, or core provisioning. Service accounts are not
human signups and are unaffected. No cutoff timestamp or backfill is needed.

The pinned Better Auth OAuth callback forwards a user-creation error's message
as `error` rather than preserving its code/description. The hook therefore uses
the message token `SIGNUP_RESTRICTED:<domain>` (or `EMAIL_NOT_VERIFIED`), which
the shared web sign-in card translates into a human-readable error.

Deploy the supporting application image and chart setting to every API replica
to close signup consistently. Removing the setting reopens signup without
changing existing accounts.

## OAuth for CLI and MCP

`me login` uses OAuth 2.1 authorization code with PKCE and an RFC 8252 loopback
redirect. The first-party `me-cli` client is public, requires PKCE, and skips
consent. The authorization server issues opaque access and refresh tokens. Both
are hashed before storage; a request is validated by hashing its presented
access token, finding an unexpired row, and resolving the bound user.

The CLI refreshes access tokens proactively shortly before expiry and reacts to
an unexpected 401 with one forced refresh. Refreshes are serialized across
processes sharing a credential store, preventing concurrent reuse of a rotated
refresh token. An injected `ME_SESSION_TOKEN` is treated as a static bearer and
is never refreshed.

OAuth credentials are user-bound. Client-credentials tokens without a user do
not authenticate the RPC APIs; independently managed automation uses a service
account API key instead.

## Device authorization

`me login --device` supports headless environments through RFC 8628. The CLI
requests a device code, presents the human with a verification URL and user
code, then polls at the server-provided interval. Issuance is restricted to the
first-party CLI, codes expire after 15 minutes, and unauthenticated code
issuance is rate-limited.

Approval creates a normal better-auth session rather than an OAuth token pair.
The returned session token is converted to a signed bearer form before it leaves
the server. The bearer plugin requires that signature, so a raw session-table
token exposed from storage cannot authenticate an API request. Device sessions
have no refresh token; they slide while used and require another device login
after expiry.

## API keys

API keys are global credentials for a user or service account and are stored
only as hashes. They select a space through `X-Me-Space`; the key itself does
not encode a space. The memory endpoint checks the holder's direct membership
in that space, then computes the holder's live tree access. Restricted keys add
a server-enforced ceiling to that access.

The user endpoint accepts both user and service-account keys, but handlers
limit service accounts to safe reads. Key-authenticated callers cannot mint or
revoke keys, preventing a compromised key from creating a replacement. Legacy
space-scoped API keys are rejected with a migration-specific error rather than
silently accepting an obsolete credential format.

## Endpoint boundaries

`/api/v1/user/rpc` authenticates a principal for account and cross-space
operations. OAuth tokens and sessions always represent users; API keys may
represent users or service accounts. The RPC method gate imposes the remaining
credential-specific restrictions.

`/api/v1/memory/rpc` also requires `X-Me-Space`. Authentication resolves the
credential holder, then requires a direct roster entry in the named space.
Membership is separate from data authority: a member with no tree grants may
reach the endpoint but receives no data from the space SQL functions.

## Operations and invariants

- Auth rows are swept on a server cron: expired sessions, verifications, OAuth
  access and refresh tokens, and device codes are removed.
- OAuth access and refresh tokens, and core API keys, are hashed at rest.
- Raw browser session tokens are intentionally not valid bearer credentials;
  only the signed device-flow form is accepted as a session bearer.
- Email verification is checked when a new human session is created. Existing
  credentials remain valid until their normal expiry or revocation.
- Auth is identity resolution, not permission granting. Space membership,
  admin authority, tree grants, and restricted-key ceilings are evaluated for
  every applicable request.

## Upgrading better-auth

better-auth and `@better-auth/oauth-provider` own the shapes of the auth
tables, but the DDL lives in our hand-written migrations
(`packages/database/auth/migrate`) with snake_case names mapped through the
`schema` options in `packages/server/auth/betterauth.ts`. A version bump can
add columns or tables the library reads at boot. The procedure:

1. Bump `better-auth` in `packages/server` and `packages/web`, and
   `@better-auth/oauth-provider` in `packages/server`, to the same version.
   Install with `./bun install --config=/dev/null` (the lockfile is frozen by
   default).
2. Run `./bun packages/server/auth/dump-schema.ts`. It builds the real
   `createBetterAuth` configuration and prints every model, column, type, and
   requiredness the installed library expects, without touching a database.
3. Diff that against `EXPECTED_COLUMNS` in
   `packages/database/auth/migrate/migrate.integration.test.ts`, which is the
   drift guard and fails on any mismatch. Write an incremental migration for
   the additions, add snake_case mappings for new camelCase fields and models
   in `betterauth.ts`, bump `AUTH_SCHEMA_VERSION`, and update the test's
   expected columns, tables, and migration list.
4. Read the release notes for behavioural changes in the plugins we use:
   `oauthProvider`, `deviceAuthorization`, `bearer`, `jwt`, and the social
   providers. Semantics can move without a schema change (1.7 replaced the
   `public`/`type` client columns with `token_endpoint_auth_method = 'none'`
   and `application_type`, which needed a data update for the seeded
   `me-cli` row; and the OAuth callback started forwarding a hook's `code` and
   `message` as `error` and `error_description`).
5. Run `./bun run check:full`. The signup integration suite exercises the
   public-client PKCE exchange and refresh; `device-flow.integration.test.ts`
   covers the device grant end to end.
6. Deploy to dev and sign in through the browser, run `me login` and
   `me login --device`, and confirm an existing CLI token still refreshes.

### Rolling back

An image-only rollback does not work: `runSchemaMigrations` refuses to start
an application whose `AUTH_SCHEMA_VERSION` is older than the version stamped
in the database. After the 1.7 migration the database says `0.0.3` and a 1.6
image says `0.0.2`, so the old image fails at boot.

To roll back to 1.6 after 008 has run:

1. `update <auth schema>.version set version = '0.0.2';`
2. Deploy the 1.6 image. It ignores the columns and tables 008 added and
   still reads `public`/`type` on `oauth_client`, which 008 left in place.
3. Sessions, CLI tokens, and API keys issued under 1.7 keep working;
   in-flight social sign-ins and device codes fail once and are retried.

Rolling forward again re-applies nothing (008 is recorded) and re-stamps
`0.0.3`. This only holds while migrations stay additive; keep dropped-column
cleanups for a later migration once the new version has run in production.
