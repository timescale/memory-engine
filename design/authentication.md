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
access token, finding an unexpired row, and resolving the bound user.

The CLI refreshes access tokens proactively shortly before expiry and reacts to
an unexpected 401 with one forced refresh. Refreshes are serialized across
processes sharing a credential store, preventing concurrent reuse of a rotated
refresh token. An injected `ME_SESSION_TOKEN` is treated as a static bearer and
is never refreshed.

A definite `invalid_grant` first re-reads the shared credential store under the
refresh lock. A newer peer token is recovered (and refreshed if necessary). If
there is no newer token, the CLI removes the rejected raw refresh token and
persists a SHA-256 rejection tombstone in the same token record. Proactive,
reactive, subsequent, and separate-process calls then raise an actionable
`ReLoginRequiredError` without replaying that token. A fresh login or successful
rotation replaces the record and clears the tombstone. This state is per server
origin and is never sent to the server. If persistence fails, a bounded local
hash-only guard still makes the rejection terminal for the running client, and
the error remains an auth error rather than a retryable storage/transport error.
Durable rejection across processes is best effort when credential storage is
unwritable; a different fresh login token bypasses the token-specific guard.
Network/transient failures remain retryable; injected bearers and API keys bypass OAuth refresh.

All production login persistence, explicit logout, refresh and rejection writes
share the mutation boundary in `credential-mutation.ts`. Interactive login and
network authorization happen outside the lock; final persistence happens under
it. Keychain-backed credentials share a stable home-relative lock across XDG
config directories, while file-only stores remain isolated by config directory.
A process waiting on the lock can recover a changed, fresh access-only/device
login, not just a peer's rotated refresh-token pair. Every definite rejection is
remembered locally before re-reading storage, since an empty keychain lookup can
be temporary unavailability rather than logout. A durable tombstone is written
only if the stored refresh token still matches. Older clients that ignore these
locks cannot be fully coordinated by a newer process. Keychain-backed clients
require a writable `~/.config/me` for this shared lock even when XDG points
elsewhere; silently falling back to different XDG lock roots would reopen the
race. A file-only sandbox can explicitly use `ME_NO_KEYCHAIN=1` with a writable
XDG directory and sign in again. Login's final persistence and logout wait at
most 45 seconds for a live lock holder, then fail closed with a busy-store error.
A slow/hung refresh can therefore require retrying login after authorization;
additional exchange-timeout/recovery hardening is a follow-up.

Background rotation and rejection writes do not change the default server;
explicit login still selects it. A generic RPC 401 no longer automatically
clears stored credentials: without the failing request's credential identity,
that could erase a newer login. It still prompts re-login, and explicit logout
clears under the shared lock. `me serve` preserves terminal local auth failures
as HTTP 401/UNAUTHORIZED, not retryable proxy 502s.

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
