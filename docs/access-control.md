# Access Control

Memory Engine organizes knowledge into **spaces**. Access within a space is granted on **tree paths**, not by role. There is no Row-Level Security — the server computes a caller's effective access and passes it into every database call.

## Principals

A **principal** is anything that can be granted access. There are four kinds:

| Kind | What it is |
|------|------------|
| **user** (`u`) | A human, authenticated by a session token (OAuth via GitHub or Google). |
| **agent** (`a`) | A non-human agent owned by one user, authenticated by an API key. Its effective access is clamped to its owner's. |
| **service account** (`s`) | A space-scoped operational identity for CI/CD, webhooks, and team-owned integrations. It authenticates by API key and has no owner clamp. |
| **group** (`g`) | A named bundle of users, agents, and service accounts. |

A **member** is the user/agent/service-account sense only — the things that can be put into a group or hold an API key. Group membership does **not** by itself confer space membership: a group's grants (and its admin, if it's an admin group) apply to you only once you have **also** joined the space directly. So an admin can add you to a group before you join — the group's access stays dormant until you do.

A group is itself part of its space's roster (it gets a roster entry when created), which is what lets you grant access to it or reference it **by name**. That roster entry is the group's own; it is separate from membership conferral, which still depends on each user/agent/service-account having joined the space directly.

### Service accounts

A **service account** is a durable operational identity administered by a team, not by one human owner. Create one with [`me service`](cli/me-service.md), then mint a key with `me apikey create --service <service>`. Service accounts are useful for CI/CD jobs, importers, webhooks, and other team-owned integrations.

Each service account has a **bound admin group**. Space admins can manage all service accounts; direct user members of that bound admin group can administer that service account — renaming it, deleting it, and managing its API keys. Users, agents, and service accounts may all be members of the bound group, but only users count as service-account admins. The service account is not automatically added to its own bound admin group, and grants to that group behave like ordinary group grants.

Service accounts start with **zero tree access**: no home grant, no default-group membership, and no owner clamp. Grant access to the service account directly, or add it to ordinary groups. A service-account key can use the memory and group/grant authorities the service account actually holds, but it cannot mint/revoke API keys or delete spaces. Scoped provisioning capabilities such as invitation creation and deprovisioning are deferred to [TNT-203](https://linear.app/tigerdata/issue/TNT-203/add-scoped-provisioning-capabilities-for-service-accounts).

## Spaces

A **space** is an isolated collection of memories with its own roster, groups, and access grants. Each space has:

- An immutable 12-character **slug** — also the `X-Me-Space` header value and the `me_<slug>` database schema name.
- A renamable display **name** (`me space rename` changes only this).

A user can belong to many spaces; each memory lives in exactly one space. There are no organization, engine, or shard concepts above a space.

## Two axes of authority

Access splits into two independent axes:

- **Structural authority** — `me space invite`, the roster (`me agent add`, `me service ...`, `me group ...`), and invitations. This is the space **admin** flag. Admin transfers through an **admin group** to its members who are also direct space members. Designate one with `me group create <name> --space-admin` or `me group set-space-admin <group>` (revoke with `--off`); `me group list` shows which groups are admin groups. Agents are never admins. Service accounts can be made space admins explicitly, but this is discouraged and they do not count toward the last-admin safeguard.
- **Data authority** — who can read/write/own memories at a given tree path. This is a **tree-access grant**.

A space must always keep at least one *effective* human admin (a user who is a direct admin or a direct member of an admin group). The last-admin safeguard rejects any removal or demotion that would drop it (error code `LAST_ADMIN`).

## Tree-access grants

A grant attaches an access **level** to a principal at a **tree path**. Levels are additive:

| Level | Name | Capabilities |
|-------|------|--------------|
| 1 | **read** | Search and retrieve memories at or below the path. |
| 2 | **write** | Read + create, update, move, and delete memories. |
| 3 | **owner** | Write + manage access (grant/revoke) within the subtree. |

Grants are **hierarchical**: a grant at `/share/work` also covers `/share/work/projects`, `/share/work/projects/api`, and so on. An `owner` grant at a path delegates access-management for that whole subtree; ownership at the root `/` (the empty path) owns the entire space.

```bash
# Grant read access to a subtree
me access grant alice@example.com /share/work r

# Grant write access
me access grant bob@example.com /share/work/backend w

# Grant ownership of a subtree (lets the grantee manage access below it)
me access grant team-leads /share/work o

# List grants in the active space (optionally scope to one principal or path)
me access list
me access list alice@example.com
me access list --path /share/work

# Remove a grant
me access rm-grant bob@example.com /share/work/backend
```

The level argument accepts `r` (read), `w` (write), or `o` (owner).

### Granting your own agents

Managing a grant normally requires **owner** at the path. The exception is your
own **agents**: an agent's effective access is always clamped to its owner's, so
you can never give an agent more than you hold. Because of that you may grant or
revoke access for an agent you own at **any** path — even one you don't own —
without holding an owner grant there. The clamp keeps it honest: grant the agent
a higher level than you hold and it clamps down to yours; grant it a path you
have no access to and the agent simply gets nothing. This lets you scope an
agent to just the part of a subtree it needs, even on shared trees you don't own.

Service accounts do **not** use this exception. They have no owner clamp, so granting access to a service account requires the normal authority: space admin or `owner` at the path. Revoking access from a service account is also allowed for space admins and direct user members of that service account's bound admin group.

## Reserved tree roots

Every space has two conventional roots:

- **`/share`** — the shared root. Memories everyone in the space should see go here. This is where the file importers default a tree-less record, and where `me memory create` / `me_memory_create` callers usually place memories.
- **`/home/<member_id>`** — a per-member private root. The input shortcut **`~`** expands to your own home, so `~/notes` means `/home/<your-id>/notes` and displays back as `~/notes`. An **agent**'s home nests under its owner's — `/home/<owner-id>/<agent-id>` — so its owner can see what the agent stores under `~` (an agent's access is capped at its owner's regardless). Service accounts do not get a home grant; put their memories under an explicitly granted path such as `/share/...`.

`/` is the canonical path separator (the leading slash is optional on input). Labels must match `[A-Za-z0-9_-]`.

### Default grants

- A space **creator** gets `admin` + `owner@home` + `owner@share` — **not** `owner@root`. So the creator sees `share` and their own `~`, but not other members' homes. Because they're an admin, they can self-grant `owner@root` if they need the whole space.
- A **user** who joins a space is granted `owner@home` (their own private root). An **agent** who joins is likewise granted owner over its home — nested under its owner's (`/home/<owner-id>/<agent-id>`) — so it's usable immediately and the grant isn't clamped away. Their **shared** access comes from the group they join (the default `team` group — see below), not from a per-invite grant.
- A **service account** starts with no tree grants and is not added to the default group. Grant it access deliberately with `me access grant <service> <path> <level>` or by adding it to an ordinary group.

### The default `team` group

Every space is auto-provisioned with a group named **`team`** (created with the space, and backfilled for spaces that predate this). It carries the standard shared-tree grants:

- **read** on `/share`
- **write** on `/share/projects`

Invitations default to adding their redeemer to `team` (`me space invite … ` without `--group`), so a new member's out-of-the-box shared access is exactly the group's grants. The group starts memberless, so it changes no one's access until members join.

A **space admin** owns these defaults and can change them at any time:

- adjust the grants — `me access grant team /share/x w`, `me access rm-grant team /share`
- manage membership directly — `me group add team <member>`, `me group remove team <member>`
- rename or delete it — `me group rename team …`, `me group delete team`
- invite into **different** groups instead — `me space invite --email … --group <name>` (repeatable: pass `--group` several times to add the joiner to multiple groups; their access is the union)

### Custom spaces

The provisioning defaults above are for a standard space. `me space create` flags let you shape a space's default access up front — e.g. a curated space you write to while others only read, or one where members can read without running up write (embedding) costs:

- `--no-home-grants` — joining users **and** agents get no `owner@~`. Service accounts never get `owner@~`. You (the creator) get **god mode** instead of the standard grants: `admin` + `owner@/` (the whole space).
- `--default-group <name>` — name the default/invite group (default `team`).
- `--no-default-group-grants` — create the default group **grantless** (no `read@/share` + `write@/share/projects`); you grant it by hand.
- `--no-default-group` — don't create a default group at all.

A fully manual, god-mode space is just `--no-home-grants --no-default-group`.

The default group is surfaced on `me space list` and is what `me space invite` targets when `--group` is omitted. Because a member needs **≥1 grant** to use a space at all (see below), a space with no home grants **and** no granted default group leaves fresh joiners locked out until you grant them access. The ergonomic pattern for "I write, others read": create with `--no-home-grants --no-default-group-grants`, grant the default group `read@/share` once, then invite through it — every joiner lands read-only, and the grant applies retroactively to anyone already in the group.

## How it's enforced

There is no Row-Level Security. For each request, the server calls `build_tree_access(principalId, spaceId)`, which collapses the principal's own grants and those from any groups it belongs to — but **only if the principal is a direct space member** — into a single set of `(tree_path, access)` rows. That set is passed as an argument into the space's SQL functions (`search_memory`, `get_memory`, …), which filter to the paths the caller may see.

The authorization gate to use a space at all is direct **space membership** (`principal_space`). A member may have zero tree grants and still authenticate for structural operations such as group management. Data-plane operations still receive the caller's effective grants; someone with no matching `read`/`write` grant sees no memories and cannot write memories. Someone who is only in a group (never joined the space) resolves to an empty access set and is denied at the membership gate.

:::warning[Quiet filtering]
Access filtering happens inside the query. If you lack `read` on a memory's tree path, a search simply returns fewer rows and `me memory get` reports "not found" — you get no error distinguishing "doesn't exist" from "not visible to you." If you're missing results you expect, check your grants with `me access list <your-principal>`.
:::

## Example: team setup

```bash
# Create and enter a space (you become admin + owner@home + owner@share; a
# default "team" group is provisioned with read on /share + write on /share/projects)
me space create "Acme Engineering"

# Invite teammates by email — they join the default "team" group (its grants
# become their shared access). Pass --admin for structural authority.
me space invite --email alice@example.com
me space invite --email lead@example.com --admin

# Or invite into other groups (repeatable; access is the union of their grants)
me space invite --email bob@example.com --group backend --group oncall

# Group people for shared grants
me group create backend
me group add backend alice@example.com
me group add backend bob@example.com

# Grant the group write access to a subtree (members inherit it)
me access grant backend /share/work/backend w

# Add one of your agents to the space and give it write access to share
me agent add ci-bot
me access grant ci-bot /share w

# Or create a team-owned service account for CI and grant it write access
me service create deploy-bot --admin ops@example.com
me apikey create --service deploy-bot ci-key
me access grant deploy-bot /share w
```

See [`me access`](cli/me-access.md), [`me space`](cli/me-space.md), [`me group`](cli/me-group.md), [`me agent`](cli/me-agent.md), and [`me service`](cli/me-service.md) for full command references.
