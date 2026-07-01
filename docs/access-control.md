# Access Control

Memory Engine organizes knowledge into **spaces**. Access within a space is granted on **tree paths**, not by role. There is no Row-Level Security — the server computes a caller's effective access and passes it into every database call.

## Principals

A **principal** is anything that can be granted access. There are three kinds:

| Kind | What it is |
|------|------------|
| **user** (`u`) | A human, authenticated by a session token (OAuth via GitHub or Google). |
| **agent** (`a`) | A service account owned by a user, authenticated by an API key. |
| **group** (`g`) | A named bundle of users and agents. |

A **member** is the user/agent sense only — the things that can be put into a group or hold an API key. Group membership does **not** by itself confer space membership: a group's grants (and its admin, if it's an admin group) apply to you only once you have **also** joined the space directly. So an admin can add you to a group before you join — the group's access stays dormant until you do.

A group is itself part of its space's roster (it gets a roster entry when created), which is what lets you grant access to it or reference it **by name**. That roster entry is the group's own; it is separate from membership conferral, which still depends on each user/agent having joined the space directly.

## Spaces

A **space** is an isolated collection of memories with its own roster, groups, and access grants. Each space has:

- An immutable 12-character **slug** — also the `X-Me-Space` header value and the `me_<slug>` database schema name.
- A renamable display **name** (`me space rename` changes only this).

A user can belong to many spaces; each memory lives in exactly one space. There are no organization, engine, or shard concepts above a space.

## Two axes of authority

Access splits into two independent axes:

- **Structural authority** — `me space invite`, the roster (`me agent add`, `me group ...`), and invitations. This is the space **admin** flag. Admin transfers through an **admin group** to its members who are also direct space members. Designate one with `me group create <name> --space-admin` or `me group set-space-admin <group>` (revoke with `--off`); `me group list` shows which groups are admin groups. Agents are never admins.
- **Data authority** — who can read/write/own memories at a given tree path. This is a **tree-access grant**.

A space must always keep at least one *effective* admin (a user who is a direct admin or a direct member of an admin group). The last-admin safeguard rejects any removal or demotion that would drop it (error code `LAST_ADMIN`).

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

## Reserved tree roots

Every space has two conventional roots:

- **`/share`** — the shared root. Memories everyone in the space should see go here. This is where the file importers default a tree-less record, and where `me memory create` / `me_memory_create` callers usually place memories.
- **`/home/<member_id>`** — a per-member private root. The input shortcut **`~`** expands to your own home, so `~/notes` means `/home/<your-id>/notes` and displays back as `~/notes`. An **agent**'s home nests under its owner's — `/home/<owner-id>/<agent-id>` — so its owner can see what the agent stores under `~` (an agent's access is capped at its owner's regardless).

`/` is the canonical path separator (the leading slash is optional on input). Labels must match `[A-Za-z0-9_-]`.

### Default grants

- A space **creator** gets `admin` + `owner@home` + `owner@share` — **not** `owner@root`. So the creator sees `share` and their own `~`, but not other members' homes. Because they're an admin, they can self-grant `owner@root` if they need the whole space.
- A **user** who joins a space is granted `owner@home` (their own private root). An **agent** who joins is likewise granted owner over its home — nested under its owner's (`/home/<owner-id>/<agent-id>`) — so it's usable immediately and the grant isn't clamped away. Their **shared** access comes from the group they join (the default `team` group — see below), not from a per-invite grant.

### The default `team` group

Every space is auto-provisioned with a group named **`team`** (created with the space, and backfilled for spaces that predate this). It carries the standard shared-tree grants:

- **read** on `/share`
- **write** on `/share/projects`

Invitations default to adding their redeemer to `team` (`me space invite … ` without `--group`), so a new member's out-of-the-box shared access is exactly the group's grants. The group starts memberless, so it changes no one's access until members join.

A **space admin** owns these defaults and can change them at any time:

- adjust the grants — `me access grant team /share/x w`, `me access rm-grant team /share`
- manage membership directly — `me group add team <member>`, `me group remove team <member>`
- rename or delete it — `me group rename team …`, `me group delete team`
- invite into a **different** group instead — `me space invite --email … --group <name>`

## How it's enforced

There is no Row-Level Security. For each request, the server calls `build_tree_access(principalId, spaceId)`, which collapses the principal's own grants and those from any groups it belongs to — but **only if the principal is a direct space member** — into a single set of `(tree_path, access)` rows. That set is passed as an argument into the space's SQL functions (`search_memory`, `get_memory`, …), which filter to the paths the caller may see.

The authorization gate to use a space at all is holding **at least one** grant. A direct member always has one (`owner@home` at minimum); someone who is only in a group (never joined the space) resolves to an empty set and is denied.

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

# Or invite into a different group
me space invite --email bob@example.com --group backend

# Group people for shared grants
me group create backend
me group add backend alice@example.com
me group add backend bob@example.com

# Grant the group write access to a subtree (members inherit it)
me access grant backend /share/work/backend w

# Add one of your agents to the space and give it write access to share
me agent add ci-bot
me access grant ci-bot /share w
```

See [`me access`](cli/me-access.md), [`me space`](cli/me-space.md), [`me group`](cli/me-group.md), and [`me agent`](cli/me-agent.md) for full command references.
