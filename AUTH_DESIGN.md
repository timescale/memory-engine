# Memory Engine — Access Control Design

## Overview

This document specifies the permission system for Memory Engine. The whole model is built from four primitives:

- **Collection** — a tenancy boundary; every memory lives in exactly one.
- **Path** — a hierarchical label (ltree) inside a collection.
- **Role** — a fixed capability tier: Viewer, Editor, Admin, Owner.
- **Grant** — a `(principal, collection, role, paths)` tuple. The only permission primitive.

The design is:

- **Simple for the common case.** Personal collections and small-team sharing should require zero permission concepts beyond "invite a member with a role."
- **Sufficient for the complex case.** Path-scoped grants, private subtrees, and agent principals cover the realistic edge cases without descending into AWS-IAM complexity.
- **Tractable to reason about.** A single resolver, additive-only grants with one named carve-out for privacy, no per-memory overrides, no deny rules. `who_can_see(memory)` is a first-class query at every layer.
- **Extensible.** Phase 1 ships a minimal model; later phases add groups, link sharing, and organizations purely additively.

Where this overlaps with existing products (GitHub, Notion, Slack, Drive) and where it deviates, see *Considered and Rejected → Anchoring on a familiar product*.

## Core Concepts

| Concept | Role |
|---|---|
| **Principal** | Anything that can be granted access — humans, agents, and groups. |
| **User** | A human principal with a global OAuth identity. |
| **Agent** | A non-human principal owned by a user (or by a collection). Authenticates via a secret. |
| **Collection** | The tenancy boundary. Every memory lives in exactly one collection. |
| **Grant** | A `(principal, collection, role, paths)` tuple. The permission primitive. |
| **Role** | A fixed capability tier (Viewer / Editor / Admin / Owner). |
| **Path scope** | An ltree prefix filter that restricts a grant to a subtree within its collection. |
| **Private subtree** | A reserved path (`~<principal>.*`) only the owning principal sees by default. |

The whole system is built from these. There is no per-memory ACL, no deny rules, no conditions, no cross-collection inheritance.

## Principals

All principals live in a single **global** table, distinguished by `kind`. This is the only auth-related table that is not per-collection — grants, group memberships, and the memory rows themselves all live in per-collection schemas (see *Implementation Notes / Schema layout*).

```
me.principal
──────────────────────────────────────────────────────────────────────────────────
id    kind    email?       owner_id?   secret_hash?   collection_id?   name
u1    human   alice@…      —           —              —                Alice
u2    human   bob@…        —           —              —                Bob
a1    agent   —            u1          <hash>         —                Claude Desktop
a2    agent   —            u1          <hash>         —                Meeting ingester
g1    group   —            —           —              work             Engineering
```

`collection_id` is set only for groups (which are collection-scoped) and identifies which collection that group belongs to; it is null for users and agents. The principals table is global so that `<c>.grant.principal_id` has a single, uniform FK target regardless of principal kind.

### Users (humans)

- Global identity (one row across the whole system) backed by OAuth (GitHub, Google).
- Membership in collections is per-collection, but the underlying identity is shared.
- A user can be a member of any number of collections.

### Agents

An agent is a non-human principal: scoped, revocable, and capped by its owner's permissions.

- Acts on behalf of an AI system, automation, or any caller using a long-lived secret.
- Has an `owner_id` referencing a user (or, in Phase 2, referencing a collection — see *Collection-owned agents*).
- Authenticates via a bearer secret. Server stores only a hash. Secret is shown once at creation and rotatable later.
- An agent's effective permissions are **capped by its owner's permissions** (the owner-ceiling rule, below).

### Owner-ceiling rule

For any agent `A` owned by principal `O`, and any memory `M`:

```
effective(A, M)  =  grants_resolve(A, M)  ∩  grants_resolve(O, M)
```

That is: the agent can do whatever its own grants permit, but never more than the owner can. This is the property the requirements call "agent has a non-strict subset of their user's memories."

Cascading effects, free of charge:

- Owner loses access to a collection → agent loses access automatically.
- Owner narrows their own role → agent's effective role narrows.
- Owner deleted → agent's permissions evaluate to nothing.

### Delegation

An agent always has its own grants (possibly empty) and is always capped by its owner's permissions. *Delegation* is a per-agent toggle that adds the owner's effective role at each memory as an additional grant candidate:

```
candidates = own matching grants  ⋃  (owner's role at M, if delegate=true)
effective(A, M) = max(candidates) capped by effective(O, M)
```

`delegate=true` is the default. It produces "agent sees everything the owner sees." `delegate=false` produces "agent sees only what its explicit grants permit, capped by owner." Setting explicit grants on a delegating agent is allowed but rarely useful — they can only match what the synthetic delegation grant already covers, and the owner-ceiling caps them either way.

The same algorithm runs whether delegating or not — one resolver, with delegation contributing an extra candidate. The `delegate` toggle does one thing: include the owner's view as a synthetic grant. The "ignore own grants when delegating" rule is unnecessary; owner-ceiling already subsumes it.

## Collections

A collection is a **context boundary** — the unit of tenancy, sharing, search, and agent connection. Every memory belongs to exactly one collection.

Collections are intended to be few in number and switched between intentionally; the separation between them is meant to be *hard*. Personal finances do not belong in a "private path" inside a work collection — they belong in a different collection, because the agents connected to work, the people work is shared with, and the backups/exports/audits of work are all different from the personal ones.

Two flavors at the user-visible layer (same shape under the hood):

- **Personal collection.** Auto-provisioned on user signup. Owner = the user.
- **Shared collection.** Explicitly created. Owner = an Organization (a billing/admin grouping introduced in Phase 3) or a single user.

Collections are lightweight to *create*, but meant to be heavyweight in what they *separate*. The model is "a few collections per person, each a clean context, organized internally by paths" — not "one collection with deeply nested permission overrides," and not "a new collection every time finer permissions are needed."

### Collection vs path: when to use which

A new **collection** when:

- It's a different trust boundary (different set of collaborators, different agents connected).
- It's a different domain of life or org (personal vs work, two distinct clients, side-project vs day-job).
- It should be backed up, exported, or audited independently.

A new **path** when:

- It's the same context, just organized differently (`projects.acme.*`, `meetings.*`, `references.*` within `work`).
- An agent should read all of one context but only write to part of it (path-scoped grants on a single collection).
- A member wants personal drafts inside an otherwise-shared context (the `~user.*` private subtree).

Rule of thumb: **if changing collection feels heavyweight, that is working as intended.** Paths are for everyday organization; collections are for actual context shifts.

## Roles

Four roles, fixed set. Roles split into two tiers based on what they govern.

The set is deliberately coarse. Finer gradations make `who_can_see` harder to answer and force users to learn a permission vocabulary instead of just seeing who is on the project. Custom roles are a Phase 4 escape valve, not a Phase 1 feature.

### Memory roles (path-scopable)

These govern actions on individual memories. A grant with one of these roles **can** carry a path filter.

| Role | Read | Create | Edit any | Delete |
|---|---|---|---|---|
| Viewer | ✓ | | | |
| Editor | ✓ | ✓ | ✓ | ✓ |

### Collection roles (always collection-wide)

These govern actions on the collection itself. A grant with one of these roles **must not** carry a path filter — reject at the API level if one is supplied. Both imply Editor on all memories within the collection.

| Role | All Editor capabilities | Manage members | Delete collection |
|---|---|---|---|
| Admin | ✓ | ✓ | |
| Owner | ✓ | ✓ | ✓ |

Path-style granularity exists *below* the management line, never *across* it.

## Grants

A grant is the system's only permission primitive. Grants live in the collection's own schema, so the collection identity is the schema name — there is no `collection_id` column on the grant row:

```
<c>.grant     -- e.g. work.grant
─────────────────────────────────────────────────────────────
principal_id   role          paths        private?
u1             Editor        *
u1             Editor        ~u1.*        true
a1             Editor        meetings.*
```

`principal_id` references `me.principal.id` (global). A principal can hold multiple grants in the same collection. Each grant has:

- `role` — one of the five roles above.
- `paths` — an ltree prefix (or set of prefixes). Defaults to `*` (whole collection). **Required to be empty/`*` if role is Admin or Owner.**
- `private` — a boolean flag. Used only by the system to mark the implicit per-member private-subtree grant. Users cannot set it.

### Resolution rule

For a given `(principal P, memory M)`, the effective role is computed as follows:

1. **Private-subtree carve-out.** If `M.path` starts with `~X.*` for some principal `X`, then only grants where `principal_id = X` (or where the requester is in *sudo mode* — see below) contribute. All other grants are silenced.
2. **Additive max-of-role.** Among the grants that contribute (the principal's own grants, plus inherited group grants in Phase 3), select all grants whose `paths` filter matches `M.path`. The effective role is the highest role among them. No matching grant ⇒ no access.
3. **Owner ceiling (for agents).** If `P` is an agent, intersect the result with the owner's effective role at `M`. The lower of the two wins.

Pseudocode:

```python
def effective_role(principal, memory):
    if memory.path matches ~X.*:
        applicable = grants(principal_id = X)
        if requester_is_sudo_admin(principal):
            applicable += grants(principal_id = principal)
    else:
        applicable = grants(principal_id = principal)
        # plus group grants for any groups principal is in

    matching = [g for g in applicable if g.paths covers memory.path]
    candidates = [g.role for g in matching]

    # Delegation: synthetic candidate equal to owner's effective role
    if principal.kind == 'agent' and principal.delegate:
        owner_role = effective_role(principal.owner, memory)
        if owner_role is not None:
            candidates.append(owner_role)

    if not candidates: return None
    role = max(candidates)

    # Owner-ceiling (always applies to agents, including delegating ones)
    if principal.kind == 'agent':
        role = min(role, effective_role(principal.owner, memory))
    return role
```

### Why this shape

- **Additive only, no deny.** Grants strictly grant. The single exception (private-subtree carve-out) is one named, bounded rule, not a user-authored deny mechanism. Keeps `who_can_see()` tractable to compute and explain.
- **Max-of-role.** A user with `Viewer at *` and `Editor at projects.*` ends up with Editor where both apply, Viewer elsewhere. Multiple grants compose without surprise.
- **Path filter belongs to the grant, not the principal.** A user/agent can have several grants with different scopes; they need not be the same role everywhere.

## Path Scopes

Path scopes reuse the existing `me.memory.tree` ltree column.

A `paths` filter is a list of ltree prefixes; a grant matches a memory if the memory's path is under any of the prefixes.

### Operations across paths

- **Read** — requires read at the memory's path.
- **Create** — requires Contributor or above at the target path. The new memory's `tree` value must fall within the principal's writable scope.
- **Edit** — requires Editor or above at the memory's current path.
- **Delete** — requires Editor or above at the memory's current path.
- **Move/rename** — requires Editor or above at **both** the old path and the new path. Otherwise path scopes are trivially escapable by moving content out.

### Listing the tree

When a principal lists tree nodes (the path namespace), they see only nodes that contain at least one memory they can read. The tree itself is not a separately permissioned object — its visibility is induced.

## Private Subtrees

Every member of a collection gets a reserved path prefix `~<principal-id>.*` that is private by default — a personal area within the shared space, invisible to others. Used for personal scratch space, drafts, agent memories the user doesn't want others to see, etc.

The private subtree is scoped to *drafts and personal notes within this context* (e.g., 1:1 notes inside a work collection, half-baked ideas about a shared project). It is **not** a substitute for keeping different contexts in different collections — personal finances belong in a personal collection, not in `~me.*` inside the work collection. The two private mechanisms are complementary: personal collections separate *contexts*; private subtrees separate the personal-but-context-relevant from the shared content within a single context.

### Mechanics

When a principal is added to a collection, the system registers an implicit grant:

```
(principal = P, collection = C, role = Editor, paths = ~P.*, private = true)
```

The `private = true` flag changes resolution **only** inside the `~P.*` subtree:

- Other principals' grants do **not** apply inside `~P.*`, even collection-wide ones like Editor at `*`.
- This is the **single carve-out** to additive max-of-role resolution.

### Admin access via sudo mode

> **Phase 2 feature.** In Phase 1, private subtrees are strictly private — no admin override exists. The mechanism below specifies the eventual Phase 2 design; the rules and transparency guarantees are what we're committing to when sudo ships, not what's available at MVP.

Collection Admins and Owners can access another member's private subtree by explicitly entering **sudo mode** — a re-authenticated, time-bounded, single-purpose elevation. It is narrow in *capability*: it only crosses the private-subtree boundary; it is not a general elevation. Admins already have manage_members and edit-all-shared-memories without sudo; the mode exists solely to cross the privacy line. Necessary for legitimate operational needs (account recovery, compliance investigation, off-boarding), and designed so it cannot be done quietly.

Sudo mode rules:

1. **Explicit entry, required reason.** `me sudo --collection <c> --reason "<free text>"`. The reason is stored verbatim.
2. **Re-authentication required.** Entering sudo requires a fresh proof-of-identity — password re-entry, OAuth re-consent, or MFA challenge per organization policy — not just an active session. Sudo issues a new short-lived credential rather than upgrading the existing one. This makes sudo a true step-up authentication event, equivalent in shape to GitHub's "sudo mode."
3. **Human principals only.** Agents cannot enter sudo, even when owned by an Admin. The owner-ceiling rule provides no path to a capability the owner must re-authenticate to acquire — agents have no way to re-authenticate, so the capability is structurally unreachable. Private subtrees are therefore safe from agents acting under admin owners, even with full delegation.
4. **Time-bounded.** Session expires after a short window (default 15 minutes, configurable up to 1 hour). Re-entry requires a fresh reason and a fresh re-authentication. The elevation cannot self-extend.
5. **Per-access audit.** Every read or write of a private memory while sudo'd writes an audit record `(admin, target, memory_id, action, timestamp, reason, sudo_session_id)`.
6. **Owner is notified.** The principal whose private space was accessed receives a notification (in-product + email) at each access. Cannot be suppressed by the admin.
7. **Visible audit trail.** The affected principal can query "who has accessed `~me.*` in sudo, when, and why" without needing admin help.

The transparency is what makes "private" a real privacy guarantee rather than a marketing word. Admins retain the operational capability they need; users retain visibility into when it has been used.

### Sharing out of private

Private and shared are mutually exclusive. To share a memory, the principal moves it out of `~me.*` into a shared path. There is **no** mechanism to "share this single private memory with one other person" — that path leads to inheritance complexity disproportionate to the value.

If a principal needs a shared-with-two-people space, they create a separate collection.

### Off-boarding

When a member is removed from a collection, their `~<principal>.*` subtree must be explicitly resolved. The UI forces the choice:

- **Keep, orphan.** Contents preserved, hidden from everyone, not surfaced in search.
- **Transfer to admin under sudo.** *(Phase 2)* Re-parented to an admin's space, audited.
- **Delete.** Permanent.

Silently exposing the subtree is never an option.

## Agents (Detail)

### Lifecycle

```bash
# Create a fully-delegating agent (most common case)
me agent create --name "Claude Desktop"
# → prints secret once

# Create a narrowed agent
me agent create --name "Meeting ingester" \
  --no-delegate \
  --grant "work:Contributor:meetings.*"
# → prints secret once

# Modify scope without rotating the secret
me agent grant add a1 --collection work --role Contributor --paths "projects.*"
me agent grant remove a1 --grant-id g42

# Rotate the secret (e.g., suspected leak)
me agent rotate a1
# → prints new secret; old secret invalidated

# Revoke the agent entirely
me agent revoke a1
```

Because grants live in a server-side table keyed by agent id, **scope changes do not require rotating the secret.** The same key keeps working with the new permissions. Rotation is for secret compromise, not for permission changes.

### Authentication

The agent secret is presented as a bearer token (e.g., `Authorization: Bearer <secret>` on HTTP, or the corresponding MCP credential field). The server hashes it, looks up the principal, and uses that principal for the rest of the request.

### Collection-owned agents (Phase 2)

Some agents belong to the team, not to a person — e.g., a meeting-ingestion bot for the engineering collection that should survive any individual user leaving. To support this, an agent's `owner_id` can reference a collection instead of a user:

```
principals
─────────────────────────────────────────────────────────────────
id    kind    owner_kind     owner_id       secret_hash    name
a3    agent   collection     work           <hash>         Engineering meetings bot
```

Collection-owned agents are managed by the collection's admins, not by any individual user. The owner-ceiling rule applies via the collection's own grants on itself — practically, collection-owned agents are bounded by what the collection contains.

This is a Phase 2 feature. Phase 1 ships only user-owned agents, with a workaround of "issue from a designated team account" for the team-bot case.

## Groups

A Group is a collection-scoped principal-like entity that bundles members and carries grants. It is itself a row in the principals table with `kind = group` and a non-null `collection_id`.

- **Collection-scoped.** A group exists within exactly one collection. There are no global or cross-collection groups.
- **Same grant shape.** Grants point to groups via `principal_id` just like users and agents. A group's grants are not constrained to be a subset of any user's — groups define their own access, and members inherit it by being in the group.
- **Membership.** A user is in a group iff a row exists in `<c>.group_member(group_id, user_id)` in the group's collection schema. Both `group_id` and `user_id` reference `me.principal.id`. Agents do not belong to groups directly; they inherit through the owner-ceiling rule from their owner's group memberships.
- **Management.** Adding or removing members requires the `manage_members` capability on the collection (Admin or Owner). Creating or deleting groups also requires this capability.
- **Effective resolution.** A user's effective grants in a collection = direct grants ∪ grants of every group they belong to. The max-of-role rule (per matching path) applies across the union.

Why not global groups: rename-and-blast-radius problems. A global group renamed or deleted has cross-tenant effects users do not expect, and it forces an organizational structure on the system before customers have one in mind. Collection-scoped keeps the blast radius contained and lets each collection structure its own membership independently.

Phase 4 introduces the option of *organization-level groups* that can be invited into a collection as a unit — those are a separate concept layered on top, not a replacement for collection-scoped groups.

## Sharing Surface

Sharing is **invite-by-handle**: access is granted to named principals with explicit roles. There is no anonymous-link path to the data.

Two levels:

1. **Private** (default for new collections). Only the owner.
2. **Invite by handle/email** → role. The primary mechanism.

Link sharing, domain-based sharing ("anyone in @example.com gets Viewer"), and request-access flows are deferred to Phase 4 (only if demanded). Most teams don't actually need them, and the "anyone with the link" pattern is a leading cause of "who can see this?" confusion — exactly what this design exists to avoid.

## Audit and Transparency

### `who_can_see(memory)`

A first-class query from day one. Returns the list of principals with effective read access to a given memory, including the path through which their access is derived:

```
who_can_see(memory_id="...") →
  - Alice   (Editor via direct grant on `work` at `projects.*`)
  - Bob     (Viewer via direct grant on `work` at `*`)
  - Claude Desktop (Editor via owner-ceiling, Alice's grant)
```

Cheap to compute if and only if the permission model has stayed clean. The implementation is a single-collection scan of `<c>.grant` joined with `<c>.group_member` — both small, both indexed. If `who_can_see` becomes expensive or unintuitive, that is the canary that complexity has crept in — back off.

### Sudo-access log

> *Phase 2 — ships with sudo mode.*

Every sudo-mode access of a private subtree writes an audit row:

```
sudo_audit
──────────────────────────────────────────────────────────────────────────────────────
sudo_session_id   admin_id   target_id   collection_id   memory_id   action   reason   ts
```

Queryable by:

- The target (to see who looked at their private space and why).
- Collection Admins (for compliance dumps).
- The user themselves at any time.

### General activity log

All writes (create, edit, delete, move) record `(principal, action, memory_id, before, after, ts)`. Standard. Used both for human-visible history and for audit/compliance.

## Permission Resolution Algorithm (Complete)

For a request `(requester, action, memory)`:

```python
def can(requester, action, memory):
    # 1. Resolve principal (handle agent vs user auth)
    principal = authenticate(requester)
    if principal is None: return False

    # 2. Find collection
    collection = memory.collection_id
    if collection is None: return False

    # 3. Find applicable grants under private-subtree carve-out
    if memory.path matches ~X.*:
        if principal.id == X:
            applicable = grants_of(X, collection)
        elif is_sudo_admin(principal, collection):
            # is_sudo_admin requires: principal.kind == 'human',
            # an active (re-authenticated, unexpired) sudo session scoped to
            # this collection, and Admin or Owner role.
            log_sudo_access(principal, X, memory)
            notify_owner(X, principal, memory)
            applicable = grants_of(X, collection) + grants_of(principal, collection)
        else:
            return False  # other principals can't see foreign private subtrees
    else:
        applicable = grants_of(principal, collection)
        applicable += grants_of_groups_containing(principal, collection)

    # 4. Filter by path
    matching = [g for g in applicable if g.paths covers memory.path]
    candidates = [g.role for g in matching]

    # 5. Delegation: synthetic candidate equal to owner's effective role
    if principal.kind == 'agent' and principal.delegate:
        owner_role = effective_role(principal.owner, memory)
        if owner_role is not None:
            candidates.append(owner_role)

    if not candidates: return False

    # 6. Compute role and apply owner-ceiling for agents
    role = max(candidates)
    if principal.kind == 'agent':
        owner_role = effective_role(principal.owner, memory)
        if owner_role is None: return False
        role = min(role, owner_role)

    # 7. Check action against role capabilities
    return action in capabilities(role)
```

Where `capabilities(role)` is:

```
Viewer:       { read }
Editor:       { read, create, edit, delete, move }
Admin:        Editor ∪ { manage_members }
Owner:        Admin ∪ { delete_collection, transfer_ownership }
```

## Worked Examples

### Personal user, default setup

Alice signs up. System creates:

- Principal `u_alice` (kind=human).
- Personal collection `alice-personal` with `u_alice` as Owner.
- Implicit private-subtree grant `(u_alice, alice-personal, Editor, ~u_alice.*, private=true)` (always present per-member).

Alice can do anything in her own collection. She can store private notes under `~me.*` (alias for `~u_alice.*`). No one else has access.

### Alice adds Claude Desktop

```bash
me agent create --name "Claude Desktop"
```

System creates:

- Principal `a_claude` (kind=agent, owner=u_alice, delegate=true).
- Returns a secret.

Effective permissions for `a_claude`: identical to Alice's, since delegate=true. Including her private subtree (it's hers, the agent acts as her).

### Alice adds a meeting ingester, narrowed

```bash
me agent create --name "Meeting ingester" \
  --no-delegate \
  --grant "alice-personal:Editor:meetings.*"
```

System creates:

- Principal `a_ingester` (kind=agent, owner=u_alice, delegate=false).
- Grant: `(a_ingester, alice-personal, Editor, meetings.*)`.

Effective permissions for `a_ingester`:

- `meetings.notes` → Editor (own grant) ∩ Owner (Alice's ceiling) = Editor. Can create, edit, and delete within `meetings.*`.
- `projects.foo` → no grant matches → no access.
- `~u_alice.diary` → no grant in the private subtree → no access. Alice's private space is safe even from her own narrowed agents.

### Shared work collection

Alice creates a shared collection `work` and invites Bob as Editor:

- Implicit private subtrees for Alice (`~u_alice.*`) and Bob (`~u_bob.*`) automatically registered.
- Direct grant: `(u_bob, work, Editor, *)`.

Bob can read and write everything except Alice's private subtree.

Alice promotes Carol to Admin:

- Grant: `(u_carol, work, Admin, *)` — note path filter must be `*`/empty for Admin.

Carol can manage members and edit all memories — but not see Alice's or Bob's private subtrees without entering sudo mode. When she does:

```bash
me sudo --collection work --reason "Off-boarding Bob, retrieving customer notes"
```

Carol gets a 15-minute window. Each access of a private memory writes an audit row and notifies Bob.

### Curator agent: read-everywhere, write-here

Alice wants an agent that scans her whole work collection for duplicates but only writes findings to `audit.curator.*`. She has Editor at `*`:

```bash
me agent create --name "Curator" --no-delegate \
  --grant "work:Viewer:*" \
  --grant "work:Editor:audit.curator.*"
```

Effective:

- `projects.acme` → max(Viewer, no-match) = Viewer (read only).
- `audit.curator.dupes` → max(Viewer, Editor) = Editor (read + write).
- All capped by Alice's Editor at `*`, which is a no-op cap (Editor ≥ everything below).

The asymmetric read/write pattern falls out of multiple grants on the same agent.

## Rollout Phases

### Phase 1 — MVP

Ship the model end-to-end with the minimum viable surface:

- Principals: User (OAuth via GitHub/Google), Agent (user-owned), Group (collection-scoped).
- Auto-provisioned personal collection per user.
- Explicit shared collections, user-owned.
- Four roles, fixed.
- Grants table with path filters, max-of-role resolution.
- Group membership (`group_members`) with grant inheritance for users.
- Private subtrees — strictly private in Phase 1, no admin override (sudo arrives in Phase 2).
- Agent secrets (create/rotate/revoke), full-delegation default.
- `who_can_see(memory)` query exposed in API and CLI, showing direct and via-group derivation.
- General write activity audit log (memory create/edit/delete/move).

### Phase 2

- Sudo mode for Admins/Owners to access private subtrees: re-authentication flow, time-bounded credentials, MFA gate, owner notifications (in-product + email), queryable `sudo_audit` table.
- "Transfer to admin under sudo" option in member off-boarding.
- Collection-owned agents (service accounts owned by a collection, not a user).
- "Block agent" mechanism for collection admins to suspend a foreign-user's agent from acting in their collection.

### Phase 3

- Organizations: billing/admin grouping above users, owning shared collections.

### Phase 4 (only if demanded)

- Organization-level groups invitable into collections as units.
- Link sharing (off by default, opt-in per collection). Deferred from Phase 2 — the "invite by handle" path covers the realistic use cases, and link sharing introduces the "who can see this?" surface area the rest of the design exists to avoid.
- Domain-based sharing, request-access flow.
- Custom roles (caller-defined capability sets).

Per-memory ACL overrides are **not** in any phase. If they ever become unavoidable, the design needs to be re-examined from the top, because their addition will reshape resolution semantics.

## Considered and Rejected

These options were considered during design and explicitly turned down. Documented here so future contributors don't need to re-litigate them.

### Anchoring on a familiar product

Several existing products were considered as a primary mental model for the doc: GitHub repositories (named collaborators with fixed roles, PATs for automation, sudo for break-glass), Notion workspaces (members + page hierarchy + private pages), Slack workspaces (workspace + channels + bots + DMs + compliance export), Google Drive (per-file ACLs, link sharing, folder inheritance).

Each overlaps partially, but each has friction as a primary frame:

- **GitHub** has no path-scoped grant primitive and no private-subtree concept (`~me/` would have to be borrowed from Unix), and its repo-centric framing reads as a developer tool to non-engineer users.
- **Notion** is closest to the domain (documents in a hierarchy, members with roles, private pages), but its dominant pattern — per-page permission overrides — is exactly what this design rejects.
- **Slack workspaces** map well at the conceptual level (workspace = collection, channels ≈ paths, DMs-with-self ≈ private subtree, bots = agents, eDiscovery = sudo), but Slack's channel namespace is flat, not hierarchical.
- **Drive's** defining features — per-file ACLs, link sharing as the dominant mechanism, folder-inherited permissions — are explicitly rejected here for the same reason they cause "who can see this?" pain in Drive itself.

The design stands on its own four primitives (collection, path, role, grant) rather than borrowing a product framing. Each candidate analogy required disowning more than it carried, so none is used as the doc's anchor. Inline comparisons (e.g., bearer tokens, step-up auth) appear only where they help a reader place a specific mechanism.

### Principal-to-principal mirror grants

A generalization of agent delegation: any principal could be granted "mirror principal X's access." This would unify agent delegation, executive-assistant access, handoff scenarios, and audit-observer patterns under one primitive. Rejected for Phase 1 because (a) the only currently-needed case — agent delegation — is already cleanly handled by the synthetic-grant model above, (b) mirror grants change a static-row algebra into a graph traversal, making `who_can_see` significantly harder to compute and explain, (c) they introduce new privacy semantics (does Bob mirroring Alice include `~alice.*`? — surely not, but that's a new carve-out to specify), and (d) the use cases beyond agents are unproven. Revisit in Phase 4 if real demand emerges.

### Per-collection users

Forcing users to register per collection. Rejected: identity drift across orgs, terrible UX for collaborators. Global users with per-collection membership is universally what mature systems do.

### Global groups

Groups visible across all collections. Rejected: cross-tenant rename/blast-radius hazards and forces premature organizational structure. Collection-scoped is sufficient through Phase 3.

### Token + scope as separate from grants

Tokens carrying their own scope object distinct from grants. Rejected after unification: the scope shape was isomorphic to grants, and a separate vocabulary added concepts without adding capability. Agents are principals; their permissions are grants; one resolver, one table, one UI.

### Per-memory ACL overrides

Allowing memory-level permissions that override collection-level ones (the Notion/Drive pattern). Rejected: the dominant cause of "I can't tell who has access to this" pain in those products. The escape valve when path scopes aren't enough is to create a separate collection — appropriate when the content is actually a different context (different collaborators, different trust boundary). If it's the same context, paths suffice.

### Deny rules

User-authored deny entries on grants. Rejected: introduces the AWS-IAM "explicit deny beats explicit allow" cognitive tax and breaks the simple `max-of-role` resolution. The single carve-out (private subtree) is a named system rule, not a deny mechanism.

### Conditions on grants

Time-of-day, IP, geo, MFA-required conditions. Rejected for Phase 1. If needed, attach them as policy at the authentication layer, not as a grant attribute.

## Implementation Notes

### Schema layout

Each collection lives in its own schema. The principals table is the only auth-related table that is global:

```
me.principal                                          -- global: users, agents, groups
                                                      -- (group rows have collection_id set)

<c>.memory                                            -- per-collection
<c>.grant         ( principal_id, role, paths, private? )
<c>.group_member  ( group_id, user_id )               -- both reference me.principal.id
```

Because memory queries target one collection at a time, the schema is fixed when the query is built. Collection identity is implicit in the schema choice; no `collection_id` columns appear on the data tables. The relevant `<c>.grant` and `<c>.group_member` tables are tiny (bounded by membership count), which is what makes query-time authorization cheap.

### Query-time authorization (CTE + qual)

Enforcement is a CTE materializing the principal's effective grants in the target collection, plus a qual appended to every memory query. Both pieces hit indexes and add negligible cost on top of the BM25/halfvec scan.

GUCs set per request:

```
SET LOCAL me.principal_id        = '<id>';
SET LOCAL me.owner_id            = '<id or null>';      -- agents only
SET LOCAL me.delegate            = '<bool>';            -- agents only
SET LOCAL me.sudo_collection_id  = '<id or null>';      -- non-null only inside sudo
```

For a human, or a delegating agent (same shape — substitute `:p_id := :owner_id`):

```sql
WITH my_grants AS MATERIALIZED (
  SELECT paths FROM c.grant WHERE principal_id = :p_id
  UNION ALL
  SELECT g.paths
  FROM   c.grant g
  JOIN   c.group_member gm ON gm.group_id = g.principal_id
  WHERE  gm.user_id = :p_id
)
SELECT m.*
FROM   c.memory m
WHERE  EXISTS (SELECT 1 FROM my_grants WHERE m.tree <@ ANY (paths))
  AND  ( m.tree !~ '~*.*'                              -- not in any private subtree
         OR m.tree <@ ('~' || :p_id)::ltree            -- or it's mine
         OR :sudo_collection_id IS NOT NULL )          -- or sudo active for this collection
```

For a non-delegating agent: two CTEs, both quals must hold, no private subtree access.

```sql
WITH
agent_grants AS MATERIALIZED (
  SELECT paths FROM c.grant WHERE principal_id = :agent_id
),
owner_grants AS MATERIALIZED (
  SELECT paths FROM c.grant WHERE principal_id = :owner_id
  UNION ALL
  SELECT g.paths FROM c.grant g
  JOIN   c.group_member gm ON gm.group_id = g.principal_id
  WHERE  gm.user_id = :owner_id
)
SELECT m.*
FROM   c.memory m
WHERE  EXISTS (SELECT 1 FROM agent_grants WHERE m.tree <@ ANY (paths))
  AND  EXISTS (SELECT 1 FROM owner_grants WHERE m.tree <@ ANY (paths))
  AND  m.tree !~ '~*.*'
```

Path intersection happens automatically: each memory has one `tree` value, and both EXISTS clauses test it against their respective grant prefixes; the row survives only if both cover it.

### Enforcement boundary

Every memory query goes through a query-builder that injects the CTE and qual. To prevent bypass from a query that forgets the injection, raw table access is revoked from the application role; reads go through a security-barrier view `<c>.memory_authz` that embeds the CTE + qual. A bypass therefore requires schema-level privilege escalation, not just an application bug.

Row-Level Security is a viable alternative for environments that prefer DB-level policy enforcement; it gives the same safety property at higher per-row cost. The schema-per-collection layout makes RLS unnecessary in practice — the security-barrier-view approach is faster and equally safe.

### Audit side-effects

Sudo-access logging (`log_sudo_access`, `notify_owner`) and the general write activity log cannot live in a `USING` clause. They are implemented via row-level triggers on `<c>.memory` and `<c>.grant`, and via application-level wrappers around the sudo read path. The qual + CTE handles admission; side effects are layered on top.

### Agent secret storage

Secrets are random 32-byte tokens, base64url-encoded. Stored as Argon2 or SHA-256 hashes (depending on rotation frequency). Never stored or logged in cleartext post-creation. Customers who lose a secret rotate; we cannot recover it.

### Audit table

Append-only. Indexed on `(target_principal_id, ts)` for the "who looked at my stuff?" query. Retained indefinitely by default; configurable per collection in Phase 3 (compliance scenarios).

### Sudo re-authentication

> *Phase 2 implementation note — see Rollout Phases.*

Entering sudo issues a new short-lived credential, not a marker on the existing session. For email/password accounts this is a password re-entry. For OAuth accounts (GitHub, Google), it requires sending the user back to the IdP with `prompt=login` (or equivalent) so they re-enter credentials at the IdP — refresh tokens are not sufficient because they do not prove a human is currently at the keyboard. The resulting credential carries `sudo_until` and `sudo_collection_id` claims and is invalidated server-side on expiry or explicit `me sudo end`.

If the organization configures MFA for sudo, the MFA challenge happens inline as part of this re-auth step. MFA policy lives at this gate and only at this gate — everyday admin actions (managing members, editing shared memories) do not require MFA; cross-the-privacy-line actions do.

Agent secrets, by contrast, can never produce a sudo credential: the `me sudo` endpoint requires an interactive auth flow and rejects bearer authentication outright. This is what enforces the "human principals only" rule from a code path, not just from policy.

### Migration

Existing single-user installations migrate by:

1. Creating one principal row per user.
2. Creating one personal collection per user with an Owner grant.
3. Mapping any existing memories to the new collection.
4. No existing data has agents or shared collections; those are net-new in this model.

## Open Questions

1. **Multiple personal collections per user.** Strict-single keeps the mental model tight; multiple lets users self-organize without involving an Org. Recommend: single in Phase 1, add multiples if pulled.
2. **Cross-collection search for an agent.** When an agent has grants on N collections, should `memory.search` natively span them? Recommend: yes, scoped by the agent's effective collections. UI defaults to single-collection search.
3. **Per-grant expiry.** A grant that auto-expires at a date is useful for temporary access (contractors, due-diligence). Lightweight to add; defer unless real demand.
4. **Quotas tied to grants.** Rate limits, storage caps per principal. Out of scope for this document; belongs to the operational layer.

## Alternatives

This section documents design alternatives that are viable but not part of the current spec. They could be added in future phases without breaking the model.

### Contributor (append-only) role

A fifth role between Viewer and Editor that allows creating new memories but not editing or deleting any — even ones the principal itself created.

**Capabilities:**

| Role | Read | Create | Edit any | Delete |
|---|---|---|---|---|
| Contributor | ✓ | ✓ | | |

**Where it would help.** Primarily agents: an ingestion bot, a scraper, or a meeting summarizer that should append observations to the corpus but not silently rewrite human-curated memories. A single prompt-injected page hitting a write-capable agent could otherwise quietly rewrite trusted memories, with the audit log as the only after-the-fact signal. Contributor turns that into a structural guardrail rather than a behavioral one.

**Where the worked examples would change.** In the *Meeting ingester* example, the grant becomes `Contributor:meetings.*` instead of `Editor:meetings.*` — the agent appends meetings but cannot rewrite or delete them. In the *Curator* example, the second grant becomes `Contributor:audit.curator.*` — the agent reads everywhere and appends findings, never edits past findings. Both materially tighten the safety properties.

**Why it's not in MVP.** The pattern is real but immediate demand is unproven. For human members, the use cases are marginal: collaborative memory is wiki-flavored, and the private-subtree feature already covers "keep my stuff mine." Shipping with fewer roles is conservative; adding a role later is purely additive.

**Append-only, not write-own.** If added, the semantics should be "can create, cannot modify any memory." It should *not* be the Drive-style "can edit memories you authored" pattern. Authorship becomes fuzzy once agents are in the picture (co-authored memories, agent-created memories, pack imports), and authorship-based permission rules don't compose well with merges, splits, or moves. Provenance belongs in the audit log; permission rules shouldn't enforce it.

**Trigger to add.** When a customer reports the safety pattern as a hard requirement — typically when deploying ingestion agents at scale and wanting the system, not the agent's prompt, to enforce append-only.
