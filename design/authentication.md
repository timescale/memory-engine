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
