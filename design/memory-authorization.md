---
title: Memory Authorization
tags: [authorization, access-control, trees, spaces, grants]
---

# Memory Authorization

Memory authorization is space-scoped and tree-scoped. Each memory has an `ltree`
path, and a caller may access a memory only when its effective grant set covers
that path at the required level. This permits shared and private subtrees in the
same space without making the full space visible to every member.

## Membership and data access

Direct membership in a space admits a user or service account to its memory RPC
endpoint. It does not grant access to any memory. A direct member with no tree
grants can authenticate successfully but has an empty effective grant set and
cannot read or mutate memory data.

Groups are principals that hold raw grants, but they are not executable callers.
Their grants become effective for a user or service account only when that member
is also directly rostered in the same space. This allows group membership to be
prepared before a member joins without granting access prematurely.

The conventional tree roots are `/share` for shared data and a private home tree
for each user. `~` is input and display shorthand for the current user's home.
Joining users normally receive `owner` access to their home; service accounts do
not have a home grant and receive access only through explicit or group grants.
Custom space provisioning can disable the automatic home grant.

## Grant model

Grants are stored against a principal and a tree path in a space. They are
hierarchical and additive: a grant applies to its path and every descendant.
There are three levels:

| Level | Name | Effect |
| --- | --- | --- |
| 1 | `read` | Read and discover memories in the covered subtree. |
| 2 | `write` | Create, update, move, and delete memories in the covered subtree. |
| 3 | `owner` | `write`, plus delegation of grants within the covered subtree. |

There are no deny entries or action-specific permissions. Removing a grant only
removes that grant; it cannot override another direct or group-derived grant.
The root path is the empty `ltree` path, displayed as `/`; an `owner` grant there
covers the entire space.

`write` is required at the affected tree. Cross-tree moves require write access
to both the source and destination. Read checks also protect named-memory
resolution, so callers cannot use a path and name to probe for inaccessible
memories.

## Effective access

At space-endpoint authentication, the server first verifies direct space
membership, then builds the caller's effective access from direct grants and
applicable group grants. The client never submits this grant set.

The resulting JSON array has this shape:

```json
[
  { "tree_path": "share.projects", "access": 2 },
  { "tree_path": "home.user_id", "access": 3 }
]
```

The server passes that array to memory data functions. Those functions
parse it and authorize an operation when at least one grant path is an
ancestor-or-self of the memory path and has an equal or higher access level.
There is no row-level security policy or caller-controlled database session
variable involved in this check.

This separation keeps grant resolution in the control plane while making the
data plane enforce every read and mutation with the same request-bound access
set. `access.effective` exposes the resolved set for inspection; raw grant rows
remain available separately through `grant.*` operations.

## Why not RLS

Earlier versions used PostgreSQL row-level security (RLS) policies to call a
tree-access check for each memory row. RLS preserved authorization correctness,
but its security barrier can prevent non-`LEAKPROOF` user predicates from being
pushed below the policy check. That can make indexes for rich memory filters
unavailable.

In manual testing with roughly 280,000 memories, a filter-only tree query using
the `ltree` GiST index took about 32 ms without RLS and about 239 ms with RLS,
where PostgreSQL selected a sequential scan. The same risk applies to other
filter dimensions that use extension operators, including JSONB containment,
temporal ranges, and regular expressions.

This is not a general rejection of RLS. It is well suited to simple, row-local
predicates such as indexed tenant equality. Memory search combines dynamic
hierarchical grants with arbitrary filters and extension indexes, where keeping
those predicates visible to the planner is necessary. Passing the resolved,
request-bound grant set to memory SQL functions keeps authorization in the
database while avoiding the RLS planning barrier.

## Administration and delegation

Space administration and tree ownership are separate authorities:

- A space admin manages structural concerns such as the roster, groups, and
  invitations. An admin may grant or remove access anywhere in the space and can
  self-grant `owner` at `/` when data ownership is needed.
- A tree owner may grant, remove, and list grants within the owned subtree even
  when they are not a space admin. This is how data-access administration is
  delegated without giving roster authority.

Grant listing is scoped the same way: an owner may list grants under an owned
subtree, while a space admin can list the full space. Members may inspect their
own effective access without either authority.

## API-key ceilings

API keys authenticate as their owning user or service account. An unrestricted
key receives that principal's live effective access in a directly admitted
space. A restricted key declares the spaces, optional space-admin authority, and
optional tree grants it may use.

Restricted-key declarations are ceilings, never additional grants. The server
intersects every declared path and level with the principal's current effective
access, retaining the narrower path and lower level. If the key, principal, or
space binding is inconsistent, the effective set is empty. Revoking or lowering
the principal's live grants therefore constrains existing keys immediately.
