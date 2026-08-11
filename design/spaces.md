---
title: Spaces and Provisioning
tags: [spaces, provisioning, authorization, groups]
---

# Spaces and Provisioning

A space is the unit of memory isolation, membership, and authorization. Each
space has a stable 12-character slug, a mutable display name, and its own memory
data schema. The slug is used for routing and is never renamed; renaming a space
changes only its display name.

Space-local schemas keep each space's data movable as scale requires. The current
deployment uses one PostgreSQL database and one connection pool, but a space
schema can later be moved to a separate database or shard without changing the
space's authorization or data model. Sharding is not part of the current request
routing design.

Spaces have no implicit relationship to one another. A user, group, or service
account must have its own direct roster entry in a space before it can act there.
Tree grants then determine which of that space's memories it may access.

## Default provisioning

Creating a standard space establishes collaborative defaults:

- The creator becomes a space admin.
- The creator owns their home tree and `/share`, but not other members' homes or
  the root of the space.
- Joining users automatically receive ownership of their own home tree.
- A memberless default group named `team` is created.
- The default group receives `read` access to `/share` and `write` access to
  `/share/projects`.

The default group's grants are ordinary tree grants. They become effective only
when a user is both directly rostered in the space and added to the group.
Service accounts never receive an automatic home tree or default-group
membership.

The default group is identified by a per-space marker, not its name. This makes
renaming robust and lets invitations consistently target the configured group.

## Custom provisioning

Space creation can opt out of any default that does not match the desired
governance model:

| Creation option | Effect |
| --- | --- |
| `--no-home-grants` | Disables automatic home ownership for every joining user. The creator instead receives admin plus `owner` at `/`, covering the whole space. |
| `--default-group <name>` | Uses a different name for the default invitation group. |
| `--no-default-group-grants` | Creates the default group without access grants, so an administrator configures its grants explicitly. |
| `--no-default-group` | Creates no default invitation group. |

Automatic home ownership is a space-wide membership rule, not a creation-time
grant only for the creator. Direct additions and invitation redemption use the
same join path, so `--no-home-grants` applies consistently to every later user.

The creator remains a space admin in either model. Standard spaces favor
least-privilege collaboration: the creator can administer the space but initially
sees only shared data and their own home. A no-home-grants space favors explicit,
central setup: the creator has root ownership to establish the access model, and
no user receives private ownership automatically.

## Invitations

Invitations are the normal way to add a user to a space with group-derived
access. Each invitation explicitly records the groups the recipient will join;
the server does not infer a group when an invitation is created. On acceptance or
link redemption, the user becomes a direct space member and is added to those
groups.

CLI and web invitation flows normally select the space's marked default group,
which is `team` in a standard space. As a result, an invited user typically gains
the default group's shared-tree access when they redeem the invitation. Directly
adding a user to a space does not add them to the default group, and an
invitation can deliberately select different groups or none.

## Lifecycle

Creating a user identity does not immediately create a personal space. Onboarding
ensures a default personal space only when the user has no existing space
memberships, preventing users who join through an invitation from receiving an
unneeded extra space.

Deleting a space removes its control-plane memberships, groups, and grants and
also drops its memory data schema. This is a full-space lifecycle operation, not
a way to remove one member or subtree.
