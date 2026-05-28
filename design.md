# Memory Engine (Re)Design

## Migration Strategy

Build the new implementation in parallel. When we're happy with it, stand up the database, stop the old server, port/copy/migrate the data from the old prod to the new database, and start the new server. We can practice this migration strategy if needed. This approach also lets us switch embedding models as we migrate; don’t move the embeddings and reembed once moved.

## V1 Scope and Non-Goals

This section captures what the first shippable version of the redesign covers and what it deliberately does not.

### Out of Scope for V1

The following are intentionally deferred. They may be revisited in a later version, but they are not built in v1 and code/design should not assume them:

- Standalone non-OAuth users. User principals are created through OAuth login. Shared service accounts, integrations, and non-human first-class accounts that authenticate only via API keys are valuable but deferred.
- Hosted MCP. The hosted API is JSON-RPC over HTTPS. MCP support exists only in the local stdio proxy.
- Magic/private-path authorization semantics. Private areas, if any, are modeled with explicit tree layout and grants, not with reserved path patterns or implicit deny rules.
- WebSocket and other streaming transports. Bulk import/export uses HTTPS in v1 and may grow chunked endpoints or signed object storage later if needed.
- Actual sharding. The schema and authorization boundary are designed to allow it, but v1 runs all spaces in a single database.
- Billing. The `core` schema may eventually host it, but v1 does not implement billing tables or flows.

### Non-Goals

The following are intentionally rejected. Do not build them, and stop and write down the requirement instead if a use case appears to need them:

- Deny rules and negative access. The access model is monotonic.
- Nested groups. A group may contain users and agents only.
- Agent space-admin or group-admin authority. Agents cannot hold or inherit administrative authority, even via membership in an admin-flagged group.

## Core

The `core` schema is a singular, global set of tables. The core manages authentication and authorization. Eventually, it will also handle billing.

### `core.version`

`core.version` records the current schema version of the global core schema. It is a singleton table: the core schema has exactly one version row.

The version row lets the server determine whether the core schema is current, needs migration, or is newer than the running server can safely handle. Unlike space schemas, the core schema is singular and global, so core migration state is not scoped by space.

The version table is intentionally separate from the migration table. The migration table records which steps were applied, but the version row gives the server a cheap compatibility check before doing any real work. If an old server connects to a newer database, it can reject the connection immediately. If the server version matches the database version, it can skip migration checks altogether.

Core SQL does not need to be templated because there is only one core schema. The schema name and table names are stable, and all references should still be schema-qualified for safety.

### `core.migration`

`core.migration` records which incremental migrations have been applied to the core schema. Each applied migration is recorded once with the target version and timestamp at which it was applied.

Core migrations use the same incremental/idempotent approach as space schemas. Incremental migrations create or transform durable tables and data exactly once. Idempotent SQL can be re-run safely to refresh functions, triggers, views, policies, and other replaceable database objects.

Keeping core migration history in `core.migration` makes bootstrap and upgrade behavior explicit and idempotent while keeping it separate from each space's own migration history.

### `core.space`

`core.space` enumerates the memory containers in the system. A space is an isolated repository of memories with its own groups and tree access rules.

Spaces are the user-facing boundary between contexts. A person may have a personal space, belong to an employer's space, and participate in other shared spaces without those memories or access rules accidentally mixing. Memory-oriented commands run in the context of one selected space. Spaces should feel "air gapped."

Each space has a stable slug used to identify it in URLs, CLI configuration, and the physical schema that stores its large operational tables. The space record also tracks placement information, such as the shard where the space's memory tables live, so the global core schema can route operations to the correct database location.

### `core.principal`

`core.principal` stores every identity-like thing that can receive privileges, authenticate, appear in audit fields, or participate in group membership.

Principals have three kinds:

- `user`: a first-class principal that is not owned by another principal. This is usually a human OAuth user, but may also be a standalone non-human account such as a shared service account, app, or integration.  
- `group`: a collection or capability principal. Groups receive privileges, and users/agents inherit those privileges through `core.group_member`.  
- `agent`: a user-owned non-human principal, such as an agent, script, local app, bot, or scheduled job. Agents are used when a human wants a tool to act with attributable, usually narrower, access.

Agents exist to make agent/script access self-service. A user can create zero or more agents without being a space admin. The owning user can manage the agent's lifecycle and can grant it access up to the access the owner already has. Agents are normal principals for authorization purposes: they can receive direct tree access, inherit access from groups, authenticate with API keys, and appear in audit fields.

Principal names follow the scope where people naturally expect them to be unique. User names are global because users are global identities that can participate in many spaces. Group names are space-specific because groups like `engineering`, `admin`, or `design` should be meaningful inside a space without conflicting with similarly named groups in other spaces. Agent names are scoped under their owning user, so multiple users can each have an agent named `claude`, `opencode`, or `importer` without conflict.

Groups are the only principals that are intrinsically scoped to a single space. A group principal records the space where it is defined, which allows group names to be unique per space. Users and agents are global principals; their relationship to spaces is represented separately through `core.principal_space`.

With the exception of the initial bootstrap user, principals start with a blank slate: no group membership, no tree access, and no space administrative privileges. Access must be granted directly, inherited through group membership, configured through agent ownership rules, or assigned by setting the space admin flag.

Agents do not start out with access equal to the owning user. If the access was intended to be equal, there's not much benefit to creating an agent (just use the user itself) (other than attribution in the case that we ever build audit logs). The major feature of having agents is the ability to give them more restricted access. Agents start with blank-slate access.

### `core.principal_space`

`core.principal_space` records which principals belong to which spaces. A principal may exist globally without being admitted to every space. To operate in a space, a user, group, or agent must have a `principal_space` row for that space.

This table is the boundary between global identity and space-local authorization. Users are global and may participate in many spaces. Agents belong to their owning user globally, but must still be admitted to a space before receiving access there. Groups are space-specific; a group principal belongs to exactly one space.

`principal_space` does not grant memory access on its own. It establishes that the principal is known in the space and records space-local state, including whether the principal is a space admin. Actual memory access comes from `core.tree_access`, either granted directly to the principal or inherited through `core.group_member`.

Groups still have `principal_space` rows even though their owning space is also recorded on the principal. This deliberate duplication keeps one rule for authorization: any principal that participates in a space has a `core.principal_space` row. It also gives groups the same space-local state as users and agents, including active/disabled state and the space admin flag.

The `admin` flag on `core.principal_space` is the space-wide administration capability. A principal with `admin = true` can administer users, agents, groups, group membership, invitations, API keys, and tree access in that space. If a group has `admin = true`, members of that group inherit space admin authority through `core.group_member`. The admin flag does not itself grant memory visibility; memory visibility and write authority still come from `core.tree_access`. However, an admin can grant tree access to any principal, including themselves.

The initial user for a space receives `admin = true` and explicit `owner` access to the root tree path. This makes initial single-player use straightforward while keeping space administration and memory visibility represented separately. The system should prevent removing or demoting the last admin principal in a space.

### `core.space_invitation`

`core.space_invitation` stores pending invitations for humans to join a space. An invitation is not a principal and does not grant access by itself. It is a pending offer to admit a user principal into a space.

Invitations are usually addressed to an email address. The invited human may already have a user principal in the system, or they may be entirely new. The system should not create a new principal merely because an invitation was sent. A principal is created or resolved only when the invited person authenticates and accepts the invitation.

Accepting an invitation creates a `core.principal_space` row for the accepting user in the invited space. If the invitation includes initial group membership, accepting also creates the corresponding `core.group_member` rows. Actual memory access still comes from group membership and `core.tree_access`; the invitation itself never grants direct memory access.

If invitations are email-based, acceptance should require the authenticated OAuth identity to have a verified email address matching the invitation. Possession of an invite link alone should not be sufficient, because links can be forwarded.

Invitations should have a lifecycle: pending, accepted, revoked, or expired. They should record who created them, when they were created, when they expire, who accepted them, and who revoked them if revoked. Revocation and expiration prevent future acceptance but do not affect already accepted memberships.

Creating an invitation requires space admin authority. If the invitation includes initial group membership, the inviter must also be allowed to administer those groups, either through the membership admin flag or through space admin authority.

Invitations avoid unwanted forced membership. A user is not added to a space until they accept, so unwanted invitations can be ignored, declined, revoked, or allowed to expire.

### `core.group_member`

`core.group_member` assigns users and agents to groups within a specific space. Every row is scoped by `space_id`, a group principal, and a member principal. A membership row means the member inherits privileges granted to the group in that space, including tree access and space admin authority.

Groups are intentionally not nestable. A group may contain users and agents, but it may not contain another group. This avoids recursive membership graphs and keeps the authorization model easier to explain: a user or agent either belongs to a group directly or does not.

Each membership can carry an `admin` flag. A member with `admin = true` can add and remove members for that group in that space, and can decide whether new memberships also receive the group membership admin flag.

The `admin` flag on a group membership controls administration of that group only. It lets the member add and remove members for the group, but it does not imply ownership of memories, visibility into all memories, or space-wide administrative authority.

Groups are the natural way to delegate access for teams. For example, a space admin can create a `project-x` group, add all project team members to that group, and grant the group `owner` access on `projects.x`. Members of `project-x` then inherit ownership of that tree branch and can manage access below `projects.x` without becoming space admins.

### `core.tree_access`

`core.tree_access` grants memory access to principals within a specific space. Every row is scoped by `space_id`, a principal, a tree path, and an access level.

Access applies to the named tree path and all descendants. Granting access on `projects.x` also grants access to `projects.x.design`, `projects.x.budget`, and future children under `projects.x` in the same space.

Access is a simple ladder:

- `read`: can search, list, and get memories.  
- `write`: includes `read`; can create, update, delete, move, and copy memories.  
- `owner`: includes `write`; can grant and revoke access below the owned path.

The model is monotonic. Grants add access; there is no deny table and no negative access rule. Removing a grant removes that exact grant, but does not create an exception below a broader inherited grant.

There is no concept of "revoking" tree access. The only mutation primitives are "add grant" and "remove grant" (also called "delete grant"). Both operate on a specific `(space_id, principal_id, tree_path, access)` row. To remove a grant, the caller must specify the grant row that exists. If the requested grant row does not exist, the operation reports an error rather than silently succeeding.

This is intentional. "Revoke access to `projects.x`" is ambiguous: does it mean "delete the matching grant row," "delete any grant that would imply access to `projects.x` (including ancestor grants)," or "make sure the principal can no longer access `projects.x` by some means"? Forcing the caller to name the exact grant row keeps the semantics explicit. If the caller's expected grant does not exist, the error surfaces the mismatch instead of hiding it behind a no-op. To reduce a principal's effective access on a subtree, remove the specific grant rows that produce that access; if access is inherited from a group, edit the group's grants or the principal's group membership instead.

Tree access can be granted directly to users, agents, or groups. Group grants are inherited by users and agents through `core.group_member`. Agents receive normal tree access like any other principal, but their owner can self-service grants up to the owner's own access.

Space admins can administer tree access anywhere in a space, but admin status does not itself imply memory visibility. Visibility and write authority come from `core.tree_access` rows.

The `owner` access level is the scoped administration mechanism for tree paths. A principal with `owner` access on `private.mat` can grant and revoke access below `private.mat` without involving a space admin. This is the intended mechanism for private user areas: if Mat owns `private.mat`, Mat can decide which users, agents, or groups can access that subtree.

The same pattern applies to collaborative project areas. Members of a team can be granted `owner` access on `projects.x`, allowing them to manage access for that branch of the tree without becoming space admins. This lets a space delegate administration of specific subtrees while keeping space-wide administration reserved for principals with `core.principal_space.admin = true`.

### Agent Access

There is a strong product argument that a user-owned agent should never have more access than its owning user. Agents exist so a user can give a tool attributable and usually narrower access than the user has. If an agent should have fully independent access, it may be better modeled as a first-class `user` principal rather than as a user-owned `agent`.

There are two possible interpretations of this rule.

The weaker interpretation is grant-time enforcement. Under this model, the system prevents an owner from granting an agent access the owner does not currently have. This is simple, but it does not preserve the invariant over time. If Alice grants `alice/agent` access to `projects.x` and later loses her own access to `projects.x`, the agent may retain stale access unless the system also finds and revokes it. Furthermore, tree access or group membership that Alice does not have might be granted directly to `alice/agent` by someone other than Alice.

The stronger interpretation is runtime capping. Under this model, an agent's effective access is always capped by the owner's current effective access. The agent can still have direct tree access and group-derived access, but those grants are masked by the agent owner's grants. The actual access used at runtime is the intersection of the agent's configured access and the owner's current access.

One implementation option is grant-time enforcement only. It is easy to implement and explain, but it is fragile. Maintaining the invariant would require cascading cleanup whenever an owner loses tree access, is removed from a group, loses space admin status, or otherwise has effective access reduced.

Another implementation option is runtime access intersection. Conceptually, compute the agent's configured effective access, compute the owner's effective access, and intersect them. For tree access, intersection is tractable because grants are path-prefix rules: overlapping paths produce the more specific path and the lower access level. For example, if the owner has `write` on `projects` and the agent has `read` on `projects.x`, the agent effectively has `read` on `projects.x`.

Runtime capping is more complex, but it actually enforces the invariant. It also handles later access changes automatically: if the owner loses access, the agent loses effective access without deleting or rewriting the agent's configured grants.

Space admin status needs special care. The simplest v1 rule is that agents cannot be space admins. This must include inherited space admin authority from groups: if a group has `core.principal_space.admin = true`, an agent's membership in that group should not by itself make the agent an effective space admin. If agents are allowed to carry or inherit the space admin flag, then an agent's effective admin authority should also be capped by the owner, meaning the agent is effectively a space admin only when both the agent and the owner have space admin authority.

Group membership has the same issue. If agents can belong to groups, group-derived access should still be capped by owner access at runtime. If that proves too complex for v1, a simpler initial version could allow agents to receive only direct tree access masks and defer agent group membership.

The preferred long-term model is runtime capping: user-owned agents are constrained by the owner's current effective access, while standalone non-human actors that need independent access are modeled as first-class `user` principals.

**V1**

- Agents cannot be space admins.
- Agents cannot be group admins.
- Agents may be group members. Group-derived tree access for an agent is intersected with the owning user's current effective access at runtime, so the "agent never exceeds its owner" invariant holds whether access comes from direct grants or group membership.
- Membership in an admin-flagged group does not make an agent an effective admin. The space-admin and group-admin restrictions apply to inherited authority as well.
- Goal: an agent's tree access (direct and group-derived) is capped by the owner's tree access and enforced at runtime.
- Agent group membership should only be removed from v1 if it proves exceedingly difficult to implement correctly. The fallback in that case is agents-with-direct-grants-only, with agent group membership deferred to a later version.

#### Agent Access Masking Implementation Sketch

Here is a vibe-coded sketch of what runtime masking might look like. I'm not at all confident in its correctness. It does illustrate that while the masking approach is conceptually simple at face value, it is not straightforward to implement.

The core masking operation takes two effective access sets:

- the owner's effective access: `(tree_path, access)`
- the agent's configured effective access: `(tree_path, access)`

The intersection rule is:

- Two paths overlap when either path contains the other.
- The effective path is the more specific path.
- The effective access level is the lower of the two access levels.

In SQL, the masking operation could look like this:

```sql
with owner_access(tree_path, access) as
(
  values
    ('projects'::ltree, 1)
  , ('projects.x'::ltree, 2)
)
, agent_access(tree_path, access) as
(
  values
    ('projects.x'::ltree, 1)
  , ('projects.y'::ltree, 2)
)
, raw_intersection as
(
  select
    case
      when o.tree_path @> a.tree_path then a.tree_path
      when a.tree_path @> o.tree_path then o.tree_path
    end as tree_path
  , least(o.access, a.access) as access
  from owner_access o
  inner join agent_access a
    on o.tree_path @> a.tree_path
    or a.tree_path @> o.tree_path
)
, merged as
(
  select
    tree_path
  , max(access) as access
  from raw_intersection
  group by tree_path
)
, reduced as
(
  select m.*
  from merged m
  where not exists
  (
    select 1
    from merged x
    where x.tree_path @> m.tree_path
    and x.tree_path <> m.tree_path
    and x.access >= m.access
  )
)
select *
from reduced
order by tree_path;
```

The `reduced` step removes redundant descendant rows when an ancestor already grants equal or greater access. For example, `projects read` makes `projects.x read` redundant, but `projects.x write` is not redundant because it is stronger than the ancestor grant.

For future access pushdown, the same operation can consume rendered JSONB access sets:

```sql
with owner_access as
(
  select tree::ltree as tree_path, access::int4
  from jsonb_to_recordset($1) as x(tree text, access int)
)
, agent_access as
(
  select tree::ltree as tree_path, access::int4
  from jsonb_to_recordset($2) as x(tree text, access int)
)
-- apply the same intersection, merge, and reduction steps
```

Memory operations would use the capped effective access set:

```sql
where exists
(
  select 1
  from effective_access e
  where e.access >= 1
  and e.tree_path @> m.tree
)
```

Write checks use `e.access >= 2`; scoped administration checks use `e.access >= 3`.

The important implementation rule is that every authorization check should flow through one effective-access function. User access is direct access plus group-derived access. Agent access is the agent's configured access, including group-derived access, intersected with the owning user's current effective access.

### Private Areas

Multiplayer spaces create an immediate product need for private areas. Teams often want a broad shared context that most members can read or write, while still giving each human a place for notes, experiments, drafts, or agent context that should not be visible to everyone else. The desired user experience is something like “give the team write access to everything shared, but not to each person's private area.”

Two approaches have been proposed.

One approach is a special carve-out rule: reserve a path pattern such as `private.<user>` or `~<user>` and define root grants to exclude those paths automatically. This would make a broad root grant behave like “everything except private areas.”

Another approach is to provision spaces with conventional top-level areas, such as `shared` and `private`. Broad team grants would apply to `shared`, while each user would receive owner access to their own subtree under `private`, such as `private.alice` or `private.bob`.

The motivation is valid: users should not need to design an access model from scratch just to get a normal shared/private collaboration pattern. The open question is whether private areas should be implemented as special authorization semantics or as a recommended tree layout and provisioning convention.

Magic private paths and implicit deny rules are problematic because they make grants harder to reason about. A grant on root would no longer mean root access; it would mean root access except for paths the system treats specially. That creates surprising behavior for users and makes it harder to explain why a principal can or cannot see a memory.

They also complicate the access evaluator. The core tree access rule is currently simple: a principal can access a memory when an allowed tree path contains the memory's tree path. Special carve-outs mean every access check must also know about reserved path patterns and subtract them from otherwise valid grants. This pushes the model toward deny semantics even if there is no explicit deny table.

Deny-like rules become especially awkward with inherited group access. If one group grants broad access and another rule implicitly denies a subtree, the system needs a conflict-resolution policy. Usually denies win, but that means adding a user to a group can unexpectedly remove access, and removing a rule can unexpectedly reveal data. Those interactions are difficult to present clearly in the product.

Magic paths also constrain future tree organization. If `private.<user>` or another pattern has special meaning, spaces cannot freely use that part of the tree for ordinary memories. The tree becomes partly user-defined and partly reserved by the authorization system, which is exactly the kind of hidden convention the design is trying to avoid.

Finally, private-path carve-outs make efficient search harder. Memory search needs to combine BM25, HNSW, ltree, metadata, temporal filters, and authorization filtering while continuing to scan until enough authorized results are found. Keeping authorization as a positive set of grant paths maps cleanly to `ltree` containment checks. Subtracting special private paths adds another dimension to every search and makes future access pushdown/sharding more fragile.

The existing primitives can already model the desired shared/private pattern without special authorization semantics. A space can place shared memories under a known branch such as `shared` or `public`, grant broad team access to that branch, and place per-user private memories under branches such as `private.alice` and `private.bob` with owner access granted only to the corresponding users.

Under this model, “grant write to everything except private areas” becomes “grant write to `shared`.” The private areas are not exceptions to a root grant; they are simply outside the broadly granted subtree.

We should defer magic private paths, implicit deny rules, and automatic private area behavior until real usage shows that the explicit tree-layout convention is insufficient. This keeps the v1 access model monotonic, efficient, and explainable.

### `core.api_key`

`core.api_key` stores API credentials for non-interactive authentication. A `user` or `agent` principal can have zero or more API keys. Groups cannot have API keys.

API keys are global credentials for a principal, not credentials for a specific space. After authenticating with an API key, the principal may operate only in spaces where it has been admitted through `core.principal_space` and only with the access granted through `core.tree_access` or inherited through `core.group_member`.

This keeps key management attached to the principal rather than duplicating credentials per space. A user's agent can use the same key across multiple spaces if it has been admitted to those spaces, while still receiving different access in each space.

API keys should support independent lifecycle management. Keys can be created, listed, revoked, and rotated without deleting the principal. A user can manage keys for their own agents, and space admins can create/delete keys for any user or agent when as required.

An API key should be split into a lookup component and a secret component. The lookup component is stored in plaintext for efficient key lookup. The secret component is shown once to the caller and stored only as a strong hash. Authentication succeeds only when both identify the same active key.

### `core.oauth_identity`

`core.oauth_identity` stores durable links between OAuth provider identities and user principals. It answers the question: when Google, GitHub, or another OAuth provider says this is user X, which `core.principal` should that authenticate as?

An OAuth identity belongs to a `user` principal. Agents authenticate with API keys, and groups do not authenticate directly.

The durable identity key is the OAuth provider plus the provider's stable subject identifier. Email addresses, display names, and avatars are useful profile metadata, but they are not the primary identity because emails can change and may not be verified.

A user may have multiple OAuth identities linked over time. For example, the same user principal may be linked to both a Google identity and a GitHub identity. A single provider identity should map to only one user principal.

`core.oauth_identity` should not store transient OAuth state. It is the long-lived account link used after an OAuth flow has completed and the provider identity has been verified.

### `core.oauth_flow`

`core.oauth_flow` stores short-lived state for OAuth login flows. This includes the temporary values needed to complete browser-based, CLI, or device-code authentication safely.

OAuth flows are not durable account links and are not login sessions. They exist only while authentication is in progress. After the flow succeeds, the system links or resolves a `core.oauth_identity` and creates a `core.session`. After the flow fails, expires, or is consumed, the flow record can be removed.

The flow record should contain enough information to validate the callback or polling request, protect against CSRF/replay, and resume the intended login operation. Depending on the OAuth mode, this may include provider, state, PKCE verifier/challenge data, device code metadata, redirect target, expiration time, and consumption status.

OAuth flow records should be treated as temporary credentials. They should expire quickly, be single-use where possible, and never grant space access by themselves.

### `core.session`

`core.session` stores interactive login sessions created after a user authenticates through OAuth. A user can have one or more active sessions, such as sessions from different machines, browsers, or CLI installations.

Sessions are global credentials for a user, not credentials for a specific space. After authenticating with a session, the user may operate only in spaces where the user has been admitted through `core.principal_space` and only with access granted through `core.tree_access` or inherited through `core.group_member`.

Sessions support normal login lifecycle management. They can be created at login, refreshed or extended according to policy, listed for account security, and revoked during logout or credential cleanup. Revoking a session invalidates that session without affecting the user, their other sessions, or their API keys.

Sessions are for user principals authenticated by OAuth. Agents and standalone non-interactive clients should use `core.api_key` instead.

## Space

Each space has a corresponding PostgreSQL schema that holds the space-local operational tables. Space schemas are created on demand when a space is created or first provisioned.

The DDL for a space schema is rendered from templates. The most important template variable is the schema name itself, because each space has its own schema. All table, index, trigger, and function references in the rendered SQL should be schema-qualified for safety and to avoid accidental dependence on `search_path`.

Space provisioning also needs per-space configuration. Different spaces may use different embedding models, and different embedding models may have different vector dimensions. The embedding dimension is therefore a template variable used when creating the `embedding` column and vector indexes. The chosen embedding model, embedding dimension, and other space-local database tuning options should be recorded in `core.space` so the server can route embedding work and future migrations correctly.

This design lets small installations keep all spaces in one database while preserving an operational boundary for future scaling. A space schema can later be placed on a different shard without changing the logical authorization model in `core`.

## `<slug>.memory`

`<slug>.memory` is the primary per-space table. Each row is one memory in the space. This table stays in the space-specific schema because it is the large, search-heavy operational data that will eventually need to scale and shard independently from global authorization metadata (if we are successful).

Each memory has a UUIDv7 primary key, textual `content`, arbitrary object-shaped JSON metadata in `meta`, a hierarchical `tree` path, optional temporal range information, an optional embedding vector, and timestamps. The `tree` path is the basis for both organization and authorization. The `meta` column supports flexible user-defined structure without creating additional tables for every memory type.

The table supports three main search dimensions:

- BM25 full-text search over `content`.  
- HNSW vector similarity search over `embedding`.  
- Structured filtering over `tree`, `meta`, and `temporal`.

The `embedding_version` column tracks whether the stored embedding corresponds to the current memory content. When content changes, the embedding is cleared and the version advances so the embedding worker can regenerate the correct vector and ignore stale queue items.

Temporal values follow one convention. Point-in-time memories use an inclusive single-point range. Period memories use an inclusive-exclusive range. This keeps temporal filtering predictable and avoids ambiguous range boundary behavior.

## `<slug>.embedding_queue`

`<slug>.embedding_queue` is the per-space work queue for embedding generation. Queue rows point to memories in the same space and record the `embedding_version` that should be generated.

The queue is version-aware. Multiple queue rows may exist for the same memory over time, but workers claim only unresolved rows and can ignore work for older embedding versions when a newer version exists. This prevents stale embedding work from overwriting newer memory content.

Queue visibility is controlled by `vt`, the visibility time. Workers claim rows whose `vt` is due and whose `outcome` is still null. Attempts and `last_error` record retry history. Finished rows are marked with an outcome such as `completed`, `failed`, or `cancelled` and can later be pruned.

The queue is space-local for the same reason as `memory`: embedding work is tightly coupled to space-local memory rows and should scale with the memory shard.

## `<slug>.version`

`<slug>.version` records the current schema version of the space-local database objects. It is a singleton table: each space schema has exactly one version row.

The version row lets the server determine whether the space schema is current, needs migration, or is newer than the running server can safely handle. This check is space-local because spaces may live on different shards and may be migrated independently.

The version table is intentionally separate from the migration table. The migration table records which steps were applied, but the version row gives the server a cheap compatibility check before operating on the space. If an old server connects to a newer space schema, it can reject the operation immediately. If the server version matches the space schema version, it can skip migration checks for that space altogether.

The table should also record when the version was last updated so migrations and operational tooling can inspect the state of a space without relying only on global metadata.

## `<slug>.migration`

`<slug>.migration` records which incremental migrations have been applied to a space schema. Each applied migration is recorded once with the target version and timestamp at which it was applied.

The migration table makes space provisioning and upgrades idempotent. When a migration runs, the migrator can skip incremental migrations that have already been recorded and apply only the missing ones. After incremental migrations complete, idempotent SQL can be re-run safely to refresh functions, triggers, and other replaceable database objects.

Keeping migration history inside the space schema makes each space self-describing. This is useful when spaces are created on demand, upgraded independently, or eventually moved across shards.

## Authorization Boundary

Authorization metadata lives in the global `core` schema. This includes spaces, principals, group membership, tree access, OAuth identities, sessions, and API keys. The per-space schemas hold the large operational data: `memory` and `embedding_queue`.

Keeping authorization metadata in `core` is important because effective access depends on several related facts: principal kind, space membership, space admin state, group membership, group administration, direct tree access, group-derived tree access, agent ownership, and the owner's own effective access. Resolving that graph should happen in one transactional context over tables with real foreign key constraints.

The boundary between authorization and memory operations should be an effective access set. Memory operations should not know how to interpret principals, groups, agents, or space admin state. They should consume rows shaped like:

```sql
(tree_path ltree, access int4)
```

The core schema should expose a function similar to:

```sql
core.effective_tree_access
( _space_id uuid
, _principal_id uuid
)
returns table
( tree_path ltree
, access int4
)
```

This function is responsible for resolving direct access, group-derived access, and agent access masking. For a user, effective access is direct tree access plus group-derived tree access. For an agent, effective access is the agent's configured access, including group-derived access, intersected with the owning user's current effective access.

Initially, space-specific memory functions can call `core.effective_tree_access(...)` directly in a materialized CTE. This preserves referential integrity for principals, groups, and tree access while keeping access evaluation inside SQL where BM25, HNSW, and tree indexes can be used correctly.

```sql
with effective_access as materialized
(
  select *
  from core.effective_tree_access($1, $2)
)
select m.*
from space_slug.memory m
where exists
(
  select 1
  from effective_access a
  where a.access >= 1
  and a.tree_path @> m.tree
);
```

In a future sharded implementation, the coordinator can call the same core function, serialize the result, and pass it to the shard-local memory function.

```sql
select jsonb_agg
(
  jsonb_build_object
  ( 'tree', tree_path::text
  , 'access', access
  )
)
from core.effective_tree_access($space_id, $principal_id);
```

A pushed-down access set would be a small list of tree paths and access levels, for example:

```json
[
  { "tree": "projects.x", "access": 2 },
  { "tree": "shared.docs", "access": 1 }
]
```

The shard-local function would parse the JSONB as a recordset, materialize it, and join memories against it.

```sql
with effective_access as materialized
(
  select tree::ltree as tree_path, access::int4
  from jsonb_to_recordset($access_jsonb)
    as x(tree text, access int)
)
select m.*
from space_slug.memory m
where exists
(
  select 1
  from effective_access a
  where a.access >= 1
  and a.tree_path @> m.tree
);
```

Clients and agents must never provide this access set directly. It is produced only by trusted server-side code after authentication and authorization. In the sharded version, the rendered access set is a snapshot for a trusted operation. If authorization changes after rendering but before shard execution, the shard executes against the rendered snapshot.

This gives us the simple first implementation while preserving a migration path for vertical scaling limits and eventual sharding. The memory layer always consumes effective access; only the source of that effective access changes.

## Deletion and Cascading

### No Soft Deletes

One cardinal rule: no soft deletes. Anywhere. Ever.

Soft deletes (`deleted_at`, `archived_at`, `is_deleted`, `active = false`, or any other "tombstone in the live table" pattern) cause problems that compound over time:

- They break unique constraints. A `name` column that should be unique now has to be unique-among-non-deleted, which means partial indexes and conditional uniqueness logic everywhere.
- They break foreign key constraints. Downstream rows can keep pointing to "deleted" parents, so every join has to filter on the soft-delete flag or risk leaking removed data.
- They bloat tables with rows nobody is supposed to see. Production tables can end up 90% dead rows, with the database wading through garbage to satisfy every query.
- They make application code ambiguous. Every query has to remember to exclude soft-deleted rows. Forgetting once is a bug; forgetting in a search query is a security bug.

The rule is simple: tables represent live state. If a row is no longer live, hard delete it.

### When to Hard Delete

Prefer hard deletes by default. Specifically:

- `core.session`: hard delete on logout, revoke, or expiry cleanup.
- `core.oauth_flow`: hard delete after consumed, failed, or expired.
- `core.api_key`: hard delete on revoke.
- `core.space_invitation`: hard delete on revoke, expiry, or after the invitation has been accepted and no longer needs to be visible.
- `core.group_member`: hard delete when membership is removed.
- `core.tree_access`: hard delete when a grant is revoked.
- `core.principal_space`: hard delete when a principal is removed from a space.
- `core.principal` (groups, agents, users): hard delete when removed, subject to cascade rules below.
- `<slug>.embedding_queue`: hard delete completed, failed, and cancelled rows via periodic cleanup.
- `<slug>.memory`: hard delete on memory delete.

### Expiry Cleanup

Some rows are inherently time-bounded: sessions, OAuth flows, invitations, embedding queue outcomes. These should have a periodic cleanup process that hard deletes rows past their expiry or retention window. Expired rows are not soft-deleted to "remember they existed"; they are removed.

If a particular table needs longer retention for operational debugging, the retention window should be configurable and enforced by the cleanup process, not by leaving expired rows in the live table indefinitely.

### Audit / Dead Tables

If we ever do need to keep evidence of a deleted row, the row must move out of the live table into a separate audit or dead table. The live table only holds live state; history goes elsewhere.

This pattern is opt-in per table. V1 does not require audit tables anywhere. If a future feature needs them (for example, compliance, billing reconciliation, or security forensics), we add a dedicated table such as `core.audit_event` or `core.dead_api_key` and write to it from the same transaction that performs the hard delete.

### Cascading Deletes

Forcing administrators to hand-revoke every grant and membership before deleting a principal is bad UX. Commands that delete parent objects should expose cascade behavior for their expected dependents rather than failing with a wall of FK errors.

The conventions are:

- `--cascade`: also delete dependent rows that would otherwise block the operation. Refers to expected, documented dependent rows for that command.
- `--force`: skip confirmation prompts. `--force` does not mean "ignore integrity"; it means "I already know what this will do."

Commands may require `--cascade`, `--force`, or both for destructive operations. The default behavior without flags should be safe and explain what is blocking the delete.

#### Deleting a Group

`me group delete <group> [--cascade]` should cascade to:

- `core.group_member` rows where the group is the group.
- `core.tree_access` rows granted to the group.
- `core.principal_space` row for the group.
- The group's `core.principal` row.

This matches intent: the group no longer exists, so its memberships and grants no longer exist either.

#### Deleting an Agent

`me agent delete <agent> [--cascade]` should cascade to:

- API keys owned by the agent.
- Group memberships for the agent in every space.
- Direct `core.tree_access` grants to the agent in every space.
- `core.principal_space` rows for the agent.
- The agent's `core.principal` row.

#### Removing a Principal from a Space

`me space member remove <principal> [--cascade]` removes that principal from the named space and cascades to:

- The principal's group memberships in that space.
- Direct tree access grants to that principal in that space.
- The principal's `core.principal_space` row for that space.

If the principal is a user with owned agents, the cascade also removes those agents from the same space (their `principal_space` row and any space-local memberships and grants). The global agent principal and its API keys remain, because API keys and agents are global, not space-scoped.

The user, their global agents, and their API keys are not deleted by this command. To delete the user globally, use a separate command.

#### Deleting a Space

`me space delete <space> [--force]` is the most destructive operation. It removes:

- All `core.principal_space` rows for the space.
- All `core.group_member` rows in the space.
- All `core.tree_access` rows in the space.
- All group principals scoped to the space.
- All `core.space_invitation` rows for the space.
- The space's per-schema operational data: `<slug>.memory`, `<slug>.embedding_queue`, `<slug>.version`, `<slug>.migration`, and the schema itself.
- The `core.space` row.

This command should always require `--force` or an explicit confirmation prompt.

### Last-Admin Safeguard

The cascade rules above do not override the invariant that a space must always have at least one admin principal. Any cascade that would remove the last `core.principal_space.admin = true` principal in a space must fail rather than leave the space adminless. The error should name the conflicting principal so the operator can promote a replacement before retrying.

## The API Server

JSON-RPC over HTTPS.

## API, Client, and MCP Boundary

The hosted API server exposes JSON-RPC over HTTPS. JSON-RPC gives us a simple, stable, application-owned protocol that we can shape around Memory Engine's product and authorization model without inheriting MCP-specific compatibility constraints.

Request and response schemas live in a shared Zod model package. This package is the source of truth for the JSON-RPC method contract and is shared by the API server and TypeScript client. The API server uses the schemas to validate requests and shape responses. The client package depends on the schema package and provides a thin typed wrapper around calling the hosted JSON-RPC API.

The CLI and local MCP server both use the client package. This keeps transport and tool-specific concerns out of the API server and avoids duplicating API call logic.

Both the schema package and client package should be published to npm. This lets external TypeScript consumers call the hosted API directly without going through the CLI or MCP layer. The client package makes it easy to use Memory Engine from TypeScript scripts with full typing and minimal boilerplate.

JSON-RPC over HTTPS is also much easier to integrate with scripts and services in other languages than a hosted MCP server would be. Any language that can make an HTTPS request and parse JSON can call the hosted API directly. A hosted MCP server, by contrast, would require MCP transport, framing, tool registration semantics, and per-client/per-model compatibility handling, which is heavy for ad-hoc scripts and integrations in languages that do not have a Memory Engine client library.

HTTPS does have one tradeoff worth noting. The previous version of Memory Engine used JSON-RPC over WebSockets, which allowed streaming for bulk imports, exports, and unusually large memories. JSON-RPC over HTTPS imposes request and response payload size limits, which is more constraining for those operations. We accepted that tradeoff because the operational and client complexity of WebSockets outweighed the streaming benefit for the common case. If bulk and streaming workloads become important, we can revisit by adding chunked endpoints, signed object storage uploads/downloads, or a streaming transport for specific operations rather than reverting the entire API.

We explicitly are not making the hosted API server an MCP server in the initial design. MCP is valuable for integrating with AI agents, but it brings extra protocol overhead and model/client compatibility constraints. Different MCP clients and model providers handle optional, nullable, tuple, record, and JSON Schema details differently. For example, some clients omit optional fields, while others send explicit `null`; some model/tooling paths render nullable unions poorly or reject certain schema shapes.

The local MCP server is therefore a stdio proxy. It exposes MCP tools to agents, handles MCP-specific schema compatibility, normalizes model/client quirks, and forwards calls to the hosted JSON-RPC API through the client package. This isolates MCP complexity in one local integration layer while keeping the hosted API clean and flexible.

The intended dependency flow is:

```text
shared zod models
  -> API server
  -> client package
  -> CLI
  -> local MCP server
```

The hosted API remains JSON-RPC. The local MCP server adapts MCP tool calls into JSON-RPC client calls. A hosted MCP server is not ruled out, but it is not part of the current implementation plan. If we add hosted MCP later, it should be an adapter over the same JSON-RPC/client boundary rather than replacing the application API.

## Environment Vars and Global CLI Options

- `ME_SERVER` or `--server` \- the URL of the API (dev/prod/self-host)  
- `ME_API_KEY` or `--api-key` \- an api key pointing to a specific user|agent  
- `ME_SPACE` or `--space` \- the slug of an space to scope commands to

## Config Files

We need to store session tokens somewhere. We need to store the currently selected space somewhere.

Use keychain so long as we keep proper scoping between servers

## Authentication Commands

### `me login [space_id|slug|name]`

Authenticates with the system via OAuth and creates a session token. Session token should be saved in a known file.

After authentication, `me login` selects a current space using the following rules:

- If the user belongs to exactly one space, auto-select it.
- If the user belongs to multiple spaces, use the space specified by the positional argument, `--space`, or `ME_SPACE`.
- If the user belongs to multiple spaces and no space was specified, show an interactive picker when stdin/stdout is a TTY. Outside a TTY, exit with an error indicating that `--space` or `ME_SPACE` is required.
- If the user belongs to no space, select none. Subsequent commands that require a space error out with guidance to create a space or accept an invitation.

The selected space is stored alongside the session credentials and scoped per server, so future invocations resume the same space without re-prompting.

### `me logout`

Expires the current session token. Removes it from the file.

### `me whoami`

Displays info about the principal and possibly OAuth stuff.

## Space Commands

### `me space use <space_id|name>`

### `me space create`

Creates a new space.

V1 does not provision any out-of-the-box tree organization. A newly created space starts with an empty tree. Space admins set up whatever layout they want. For single-player mode, most users will just start writing memories at whatever paths make sense to them.

The creating user receives:

- `core.principal_space.admin = true` for the new space.
- `owner` access on the root tree path, so they can grant and revoke access anywhere below it.

Stretch goal (only if time permits): a `--template <name>` or `--multiuser` flag that provisions some out-of-the-box structure for collaborative spaces (for example, a `shared` branch with team grants and `private.<username>` branches owned by individual users). This is explicitly optional for v1 and should not block shipping.

### `me space delete`

### `me space alter`

### `me space list`

### `me space invite`

### `me space invite list`

### `me space invite revoke`

## User Commands

User principals are created via OAuth login and managed primarily through identity, invitation, and space membership commands. The `me user` command surface is therefore mostly unneeded for the immediate next version.

Standalone non-OAuth users (for example, shared service accounts, integrations, or non-human first-class accounts that authenticate only via API keys) are valuable in the longer term, but we are deferring them until after the initial release. When we add them, this section will define commands for creating, renaming, deleting, and inspecting standalone user principals.

For now, the only intentionally supported user-management surface is:

### `me user group list <user_id|name>`

Lists the groups the named user belongs to in the current space.

## Agent Commands

### `me agent create <name>`

Creates an agent principal owned by the current user.

### `me agent delete <agent_id|name>`

Deletes an agent principal owned by the current user.

### `me agent rename <agent_id|name>` 

Creates an agent principal owned by the current user.

### `me agent group list <agent_id|name>`

probably more commands here

## Group Commands

Group commands must either have ME\_SPACE or \--space specified, or they use the currently `use`d space.

### `me group create <name>`

You must be a space admin to create new groups.

### `me group delete <group_id|name>`

You must be a space admin to delete groups.

### `me group rename <group_id|name> <new-name>`

You must be a space admin to alter groups.

### `me group member add <group_id|name> <member_id|name>`

You must be a space admin or be a member of the group with the `admin` flag on the membership in order to add members. Member must be in the `core.principal_space` table for this space. Member cannot be another group.

### `me group member remove <group_id|name> <member_id|name>`

You must be a space admin or be a member of the group with the `admin` flag on the membership in order to remove members.

### `me group member list <group_id|name>`

Any user|agent in `core.principal_space` for the space may list members of a group in the space.

## Access Commands

There is no `me access revoke`. The only mutation verbs are `grant` and `rm-grant`, matching the `core.tree_access` semantics: a grant is a specific `(principal, tree_path, access)` row, and removing one removes that exact row.

### `me access grant <principal_id|name> <tree-path> <r|w|o>`

Creates a `core.tree_access` row for the principal at the given tree path with the given access level. If an equivalent grant already exists, the command reports that fact rather than silently succeeding.

### `me access rm-grant <principal_id|name> <tree-path> <r|w|o>`

Deletes the specific grant row identified by `(principal, tree_path, access)`. If no such row exists, the command errors out. This is intentional: callers must name the exact grant they intend to remove, so unexpected "missing" grants surface as errors instead of silent no-ops.

`rm-grant` does not cascade to ancestor or descendant grants and does not affect access inherited through group membership. To reduce inherited access, remove the relevant group's grant or change the principal's group membership.

### `me access list <principal_id|name>`

Lists all `core.tree_access` rows for the principal in the current space, including both direct grants and group-derived grants (clearly labelled).

### `me access list <tree_path>`

Lists all `core.tree_access` rows in the current space whose path is an ancestor of, equal to, or a descendant of the given path, so admins can see who has access to a given subtree.

## API Key Commands

### `me apikey create <member_id|name>`

If not specified, lists api keys for self. Otherwise, must be an agent owned by the user.

### `me apikey list <member_id|name>`

If not specified, lists api keys for self. Otherwise, must be an agent owned by the user.

### `me apikey revoke <api_key_id>`

API key must belong to the user or an agent owned by the user.

## Memory Commands

Can we make `memory` optional? Can the memory commands be top-level?

### `me [memory] create`

### `me [memory] get <memory_id>`

### `me [memory] edit <memory_id>`

### `me [memory] patch|update`

### `me [memory] delete|rm <memory_id>`

### `me [memory] delete|rm --tree <ltree>`

### `me [memory] tree --tree <ltree> --levels`

### `me [memory] move|mv <ltree> <ltree>`

### `me [memory] copy|cp <ltree> <ltree>`

### `me [memory] search`

### `me [memory] import`

### `me [memory] export`

## MCP Server

### Local MCP `me mcp`

Runs a stdio MCP server locally scoped to a space and user. The MCP server proxies to the hosted API. Uses an API key via either ME\_API\_KEY or \--api-key.

The benefit of a local MCP server is that it can import/export to/from files without reading the contents through the context window (although, this is something of a security hole).

- me\_memory\_get  
- me\_memory\_search  
- me\_memory\_update|patch  
- me\_memory\_delete  
- me\_memory\_tree  
- me\_memory\_import  
- me\_memory\_export

### Hosted MCP

No file-related tools. More thought needs to go here.

- me\_memory\_get  
- me\_memory\_search  
- me\_memory\_update|patch  
- me\_memory\_delete  
- me\_memory\_tree
