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

## OAuth for CLI and MCP

`me login` uses OAuth 2.1 authorization code with PKCE and an RFC 8252 loopback
redirect. The first-party `me-cli` client is public, requires PKCE, and skips
consent. The authorization server issues opaque access and refresh tokens. Both
are hashed before storage; a request is validated by hashing its presented
access token, finding an active row, and resolving the bound user. Validation
also rejects in-place revocation, a disabled client, or an expired bound session.
Sign-out revokes existing session-bound access tokens and refresh grants
**without** `offline_access`. Real offline refresh grants deliberately survive
browser sign-out, as upstream intends; they can mint accepted new access tokens
afterward. Browser sign-out is not revocation of offline CLI authorization: use
the OAuth revocation endpoint to revoke that grant. Authorization-code replay
revokes the tokens issued for that code. Revocation in Better Auth 1.7 is no
longer represented only by row deletion.

The CLI requests no RFC 8707 `resource`: it continues to receive unbound opaque
tokens. We previously configured no `validAudiences`; its 1.7 replacement is an
explicit empty `resources` list with per-client enforcement enabled. No resource
or client-resource grants are invented during migration. Unknown resources and
resources without an explicit client link are rejected by the authorization
server. The RPC validator accepts only unbound opaque bearer tokens, rejecting
resource-bound tokens (including userinfo-only audiences), JWT access tokens,
and sender-constrained/DPoP tokens. Adding resource-bound API access requires a
separate coordinated client/provider/resource-server change; populating the
resource registry alone must not make foreign-audience tokens work at the RPCs.

The CLI refreshes access tokens proactively shortly before expiry and reacts to
an unexpected 401 with one forced refresh. Refreshes are serialized across
processes sharing a credential store, preventing concurrent reuse of a rotated
refresh token. An injected `ME_SESSION_TOKEN` is treated as a static bearer and
is never refreshed.

Before the provider reads a refresh grant, an auth middleware calls the targeted
`prepare_oauth_refresh` SQL function with its stored token hash. The function
locks its browser-session row, checks expiry after the lock, and atomically
detaches only that offline refresh grant or revokes an ended online-only grant.
Already unbound refresh grants without `offline_access` are also revoked (a
refresh can narrow scopes and drop offline permission). The next issuance reads
the updated association, so a normal offline CLI refresh works immediately on
browser-session expiry, without waiting for the 15-minute sweep. Old access
tokens stay bound to the expired browser session and remain invalid. This does
not sweep unrelated rows, renew the browser session, relax access-token session
checks, or alter provider rotation/replay behavior. The middleware relies on our
configured opaque, unprefixed/unencrypted refresh format and shared token hash;
changes to that format must update normalization too.

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
  access and refresh tokens, and device codes are removed. Before deleting an
  expired session, the sweep revokes its bound access tokens **and refresh
  grants without `offline_access`**; otherwise the `ON DELETE SET NULL` foreign
  key would reactivate inactive online credentials as unbound tokens. Genuine
  offline refresh grants survive both ordinary session expiry and explicit
  browser sign-out, matching the provider's policy; existing access tokens do
  not survive. Narrowing an offline grant's scopes to omit `offline_access`
  removes that refresh grant's offline privilege.
- OAuth access and refresh tokens, and core API keys, are hashed at rest.
- Raw browser session tokens are intentionally not valid bearer credentials;
  only the signed device-flow form is accepted as a session bearer.
- Email verification is checked when a new human session is created. Existing
  credentials remain valid until their normal expiry or revocation.
- Auth is identity resolution, not permission granting. Space membership,
  admin authority, tree grants, and restricted-key ceilings are evaluated for
  every applicable request.

## Upgrading Better Auth

Both `better-auth` and `@better-auth/oauth-provider` are pinned to exactly
**1.7.10** (the web client uses the same version). Do not treat a successful
TypeScript build as proof of database compatibility. Our hand-maintained DDL
and snake-case field mappings must match the installed runtime schema.

For each upgrade:

1. Read the [upstream upgrade guide](https://www.better-auth.com/docs/guides/1-7-upgrade-guide)
   and the **installed version's** core `get-tables`, JWT schema/adapter,
   OAuth-provider schema, token issuance/introspection/revocation, and device
   schema/routes. Compare optional fields as well as required fields: the
   adapter selects all mapped columns.
2. Add a new incremental migration; never modify previously deployed
   incrementals. Keep IDs, token hashes, secrets, subject keys, and grants
   intact. Update idempotent definitions and increment `AUTH_SCHEMA_VERSION` so
   an older server cannot reapply incompatible behavior after cutover.
3. Update the mappings in `packages/server/auth/betterauth.ts`. Keep the
   standalone device plugin unless deliberately changing the CLI protocol.
4. Run the auth migration suite, `auth/upgrade.integration.test.ts`, device-flow
   suite, cleanup suite, and auth middleware suites against local PostgreSQL.
   The upgrade regression reconstructs the old schema with its original
   migration files, inserts existing data, and then applies the new migrator
   twice. Its runtime-schema assertion derives columns from Better Auth, not
   just a second hand-written list. Social-provider identity resolution and
   legacy encrypted signing-key use are tested offline; live social redirects
   still need a deployment smoke test with the configured provider apps.

### 1.6.20 → 1.7.10 migration (`008_betterauth_1_7`)

- **Account identity is unchanged.** Early 1.7.0–1.7.2 required an `issuer`
  column; upstream reverted that in 1.7.3. 1.7.10 again identifies accounts by
  `(providerId, accountId)`. Our existing unique constraint already enforces
  this key, and Google/GitHub subjects and user IDs are preserved without any
  issuer or email-based identity backfill. This upgrade starts from 1.6.20, not
  one of the short-lived issuer-schema versions.
- **Client backfill:** `type` (`web`/`native`) becomes `application_type`;
  public clients with no explicit authentication method become `none`, while
  confidential clients default to `client_secret_basic`. Existing explicit
  methods, secrets, redirect URIs, PKCE, consent flags, and registrations are
  preserved. Removed `public`/`type` columns remain as inert legacy columns;
  the adapter no longer reads or writes them. Omitted/null types, unknown types
  (including old user-agent-based registrations), or conflicting
  public/auth-method settings fail the migration transaction and require
  operator review, rather than guessing a weaker policy. In particular, 1.6
  allowed an omitted type with native/loopback redirects, while 1.7 would default
  null to `web` on client updates and reject those existing redirects. Before
  retrying migration, inspect every legacy client's intended redirect/application
  policy and explicitly set `type` to `native` or `web`; do not bulk-default
  omitted types to `web` or infer intent from redirect URLs alone. Discovery
  provenance stays null. New machine-scope allowlists start empty (machine tokens
  do not authenticate our user-bound
  RPCs); enabling approved machine scopes is a separate decision.
- **Additive schema:** resource and client-resource tables (unique client/resource
  pair), client assertion replay table, new client metadata, token audience,
  requested-userinfo-claim, authorization-code replay, confirmation, access
  revocation, and refresh rotation/replay columns are added. Existing tokens and
  consents receive no invented resources or sender bindings. The consent user
  reference becomes nullable, matching the upstream model.
- **Signing keys:** nullable JWT `alg`/`crv` columns are added. Legacy encrypted
  keys are untouched; the upstream adapter interprets null algorithm metadata
  using the configured default. No private-key decoding or re-encryption is
  performed by the migration.
- **Sessions/device:** the core session shape has not changed. Standalone
  `deviceAuthorization` still mints sessions, not OAuth token pairs; existing
  approved/pending codes remain usable. Its required unique code indexes were
  already created in migration 007. Do not add `oauthClientId`/`resources` to
  this table: those belong to the separate opt-in `oauthDeviceAuthorization`
  integration, which is not enabled here.

Deploy packages, mappings, and migrations together after backing up the auth
schema. Stop old instances before accepting traffic on the new version: retaining
legacy columns is data preservation, not support for mixed-version OAuth
issuance or rolling back the migration with an older server. Schema version
0.0.3 rejects that downgrade. Resource registration, private-key client auth,
back-channel logout registrations, and DPoP are not newly enabled by this upgrade.
