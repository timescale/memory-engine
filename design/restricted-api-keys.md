---
title: Restricted API Keys
tags: [authorization, api-keys, personal-access-tokens, sandboxing]
---

# Restricted API Keys

API keys are credentials for a user or service account. They are global to that
principal rather than intrinsically bound to one space. An unrestricted key has
the same live authority as its holder in every space where that holder is directly
admitted.

A restricted key adds an explicit, server-enforced ceiling. It is intended for
uses that need less authority than the user normally has, especially a coding
harness in a sandbox. A restricted personal access token lets the sandbox receive
only the spaces and trees relevant to its task, reducing both data exposure and
unnecessary model context. The sandbox must not also receive the user's broader
credentials, or it can bypass the intended restriction.

## Key lifecycle

A user can mint a personal access token for themselves or a key for a service
account they administer. The plaintext key is returned only at creation; the
server stores only its hash. Keys may expire, and deletion is revocation.

Key creation and deletion require a user session. API-key-authenticated callers
cannot mint or revoke keys, preventing a leaked key from creating a replacement
that survives its own revocation.

## Declarations

Omitting access declarations creates an unrestricted key. Supplying one or more
per-space declarations creates a restricted key. Each declaration contains:

| Field | Meaning |
| --- | --- |
| Space | A space where the key may be used. The holder must be a direct member. |
| Tree grants | Optional path and access-level ceilings: `read`, `write`, or `owner`. |
| Space admin | Optional permission to exercise the holder's existing space-admin authority. |

A declaration with no tree grants allows the holder's full *live* tree access in
that declared space. It does not grant root ownership or any access the holder
does not already have. A declaration with tree grants limits the key to those
paths and levels.

A restricted service-account key can declare only its service account's space.
The CLI exposes declarations with repeatable `--allow` options and optional
`--space-admin`; the latter requires an `--allow` declaration for the same space.

## Effective authority

The key declaration is a ceiling, not an independent grant. For each request,
the server first resolves the holder's current direct membership and effective
tree grants. It then intersects that live authority with the key's declaration:

- The key must declare the selected space.
- For overlapping tree grants, the effective path is the narrower path and the
  effective level is the lower level.
- A declared space-admin capability is effective only when the holder is also a
  live space admin.

An inconsistent key, principal, or space binding resolves to no tree access. Any
later loss of space membership, grant, or admin authority takes effect on the
next request without rotating the key.

## Endpoint behavior

Restricted keys authenticate as their holder; they do not impersonate an agent
or alter the principal model. On the memory endpoint, normal tree-access checks
consume the key-clamped effective grant set.

For the user endpoint, a restricted personal access token may inspect its
identity and discover only its declared spaces. It cannot manage account
resources, including API keys. This prevents a scoped token from widening or
replacing its own authority.

## Choosing an identity

Use a restricted personal access token when a sandboxed harness needs a reduced
view of one user's existing access. Use a service account when automation needs
its own independently managed identity and grants. Neither model relies on a
harness-specific principal or credential impersonation.
