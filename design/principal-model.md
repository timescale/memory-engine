---
title: Principal Model
tags: [authorization, principals, users, groups, service-accounts]
---

# Principal Model

The authorization model has three principal kinds:

| Kind | Purpose | Credential-bearing |
| --- | --- | --- |
| User (`u`) | A global human identity. | Yes |
| Group (`g`) | A space-scoped collection for grants and delegated administration. | No |
| Service account (`s`) | A space-scoped non-human identity for independent automation. | Yes |

`principal` is the common unit used by the space roster and tree grants.
`member` is deliberately narrower: it means only a user or service account, the
two kinds that can belong to groups and hold API keys.

## Users

Users are global principals whose IDs match their authentication identities. They
can be directly rostered in multiple spaces and authenticate through user
credentials, including personal API keys. A user's name is its global identity
handle, so it is not renamed through space-management operations.

Joining a space makes a user a direct member and normally grants ownership of
that user's home tree. The user receives no other data access unless it is
granted directly or through a group.

## Groups

Groups belong to one space and are rostered into that space when created, making
them resolvable grant recipients. A group can receive tree grants and can be
made an admin group, but it cannot authenticate, hold an API key, or be a group
member itself. Groups cannot nest; only users and service accounts can be group
members.

Group membership is space-scoped and non-transitive. It does not admit a user or
service account to the space: group-derived tree grants and admin authority take
effect only after that member has its own direct roster entry. This permits
preparing group membership before a user joins without prematurely granting
access.

A group's `admin` roster flag makes it an admin group, whose authority flows to
its direct user members that are also direct space members. This is distinct from
the group-member admin flag, which controls administration of that group itself.

## Service accounts

Service accounts are independent, non-human principals for automation. They are
created in exactly one space, are directly rostered there, and use API keys to
authenticate. A service account starts with no tree grants, no home tree, and no
default-group membership; it receives access only through explicit grants or
ordinary group membership.

Creating a service account also creates a bound, name-derived admin group. Space
admins, or direct user members of that bound group who are also direct space
members, may manage the service account and its API keys. The bound group is an
administration mechanism, not an automatic data-access grant.

Service accounts may be ordinary group members and group administrators. They do
not inherit space-admin authority from admin-group membership; only a direct
space-admin roster entry can make a service account a space admin.

## Why there is no agent principal

The retired `agent` principal kind represented a harness-specific subordinate
identity. Its purpose was valuable: let a user give a coding harness only the
memories relevant to its task. A restricted scope reduces both data exposure and
model-context waste from unrelated memories.

Its effective access depended on its own grants, group membership, owner
relationship, home path, and an additional runtime intersection with the owner's
access. In other words, the agent's authorization was capped by its owner's.
This was powerful, but difficult to reason about.

The agent principal existed to restrict a coding harness. That required the CLI,
MCP server, hooks, and other integration surfaces to run as the agent whenever a
harness was active. Detecting that context and locking it to the correct agent was
complex, especially when projects on the same machine needed different agent
identities. In practice, a harness that could reach the user's credentials could
escape the intended scope and use those broader credentials.

It also conflated two separate decisions: installing a local AI harness and
creating an independent identity with its own IAM relationship. Harness commands
now always run as the principal represented by their actual credential; there is
no agent impersonation or agent-specific access header.

The reliable way to restrict a harness is to run it in an environment that never
receives the user's credentials. In that setting, a restricted personal API key
can enforce the desired space and tree-access ceiling with much less complexity
than a separate agent principal. Independent automation that needs its own
credential and permissions uses a service account. These approaches keep the
integration identity, grants, and administrators explicit and inspectable without
coupling harness configuration to a hidden subordinate-principal model.
