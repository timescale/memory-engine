# me space

Manage spaces.

A **space** is an isolated collection of memories with its own roster, groups, and access grants. It is identified by an immutable 12-character **slug** (also the `X-Me-Space` header value and the `me_<slug>` database schema) and a renamable display **name**. Your *active* space is the one carried on every memory command; set it with `me space use` (or `me login <space>`).

These commands authenticate with your **session** (humans only — `me login`). Invitations operate on the active space.

## Commands

- [me space list](#me-space-list) -- list the spaces you belong to
- [me space use](#me-space-use) -- set the active space
- [me space create](#me-space-create) -- create a space
- [me space rename](#me-space-rename) -- rename a space
- [me space delete](#me-space-delete) -- delete a space
- [me space invite](#me-space-invite) -- invite a user (and manage invitations)

---

## me space list

List the spaces you belong to. The active space is marked. Alias: `me space ls`.

```
me space list
```

---

## me space use

Set the active space (the `X-Me-Space` context used by other commands).

```
me space use [space]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `space` | no | Space slug or name. Prompts interactively if omitted. |

The write goes to the config that **currently governs** the space resolution
(like `git config` editing the effective scope):

- If a [`.me` project config](../project-config.md) in scope defines `space`,
  that file is updated — `.me/config.local.yaml` if it defines `space` (it
  overrides the committed file per field), else the committed `.me/config.yaml`.
  If the effective server differs from what the project would resolve on its
  own (e.g. a `--server` override), `server:` is rewritten alongside so the pin
  stays self-consistent.
- Otherwise, the per-server `active_space` in the global
  `~/.config/me/config.yaml` is updated, as before.

The command prints which file it saved to. Note that `ME_SPACE`, when set,
still overrides whatever was saved.

---

## me space create

Create a new space and make it active. As the creator you always become a space **admin** (so you can reshape access however you like); the flags below only set the space's **default** access. With no flags you get today's conventions: `owner@home` + `owner@share` (not `owner@root`), joining users/agents automatically get `owner@~`, and a default `team` group is created with `read@/share` + `write@/share/projects`.

```
me space create <name> [--no-home-grants] [--default-group <name>]
                       [--no-default-group-grants] [--no-default-group]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Display name for the space. |

| Option | Description |
|--------|-------------|
| `--no-home-grants` | Joining users **and** agents get no `owner@~`. You (the creator) get **god mode** instead: `admin` + `owner@/` (the whole space). |
| `--default-group <name>` | Name the default/invite group (default `team`). |
| `--no-default-group-grants` | Create the default group **without** `read@/share` + `write@/share/projects` — a grantless group you configure by hand. |
| `--no-default-group` | Don't create a default group at all. |

The name, grants, and existence of the default group are independent axes, so `--default-group team` behaves exactly like the bare default. A fully manual, god-mode space is just `--no-home-grants --no-default-group`. Conflicting combinations error (e.g. `--no-default-group` with `--default-group` or `--no-default-group-grants`).

> **Note:** in a space where members get no automatic access (`--no-home-grants` and no granted default group), a fresh joiner holds **zero grants and is locked out** until you grant them access — grant a default group `read@/share` once and invite through it (see [`me space invite`](#me-space-invite)) so joiners land read-only.

---

## me space rename

Rename a space's display name. The slug is immutable (it's the schema name and routing key), so this changes only the label.

```
me space rename <space> <new-name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `space` | yes | Space slug or name. |
| `new-name` | yes | New display name. |

---

## me space delete

Permanently delete a space and all its data — memories, grants, groups, invitations. Irreversible. Alias: `me space rm`.

```
me space delete <space> [--force]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `space` | yes | Space slug or name. |

| Option | Description |
|--------|-------------|
| `--force` | Skip the confirmation prompt. |

---

## me space invite

Invite someone to the active space, or create an open shareable link. Every invite adds its redeemer to one or more **groups** — the union of those groups' grants becomes the joiner's shared access. When `--group` is omitted it defaults to the space's own **default group** (usually `team`, but a custom space may have renamed it or have none — then `--group` is required). Every invite is **pending** until the invitee accepts (email invite) or redeems the link; nothing auto-enrolls. **Admin only.**

```
me space invite --email <addr> [--admin] [--group <name-or-id> ...]
me space invite --anyone [--admin] [--group <name-or-id> ...] [--expires <dur>] [--max-uses <n>]
```

| Option | Description |
|--------|-------------|
| `--email <addr>` | Invite a specific email (only they can join; single-use). |
| `--anyone` | Create an open link anyone signed-in can use to join (multi-use). |
| `--admin` | Make the joiner a space admin (structural authority). |
| `--group <name-or-id>` | A group the joiner is added to; its grants are their shared access. **Repeatable** — pass `--group` multiple times to add to several. Default: `team`. |
| `--expires <duration>` | Open-link expiry, e.g. `7d`, `24h`, `30m`. |
| `--max-uses <n>` | Max redemptions for an open link. |

Example — invite into two groups:

```
me space invite --email alice@example.com --group team --group backend
```

Exactly one of `--email` or `--anyone` is required. A joining user always receives `owner@home` (their private root); their **shared** access comes from the group they join — the default `team` group grants `read` on `/share` and `write` on `/share/projects`. See [Access Control](../access-control.md#the-default-team-group) for changing these defaults.

### me space invite list

List pending invitations for the active space. Alias: `me space invite ls`.

```
me space invite list
```

### me space invite revoke

Revoke a pending invitation by email.

```
me space invite revoke <email>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `email` | yes | The invited email to revoke. |

## See also

- [Access Control](../access-control.md) -- principals, the two axes of authority, and tree-access grants.
- [`me access`](me-access.md) -- grant read/write/owner access on tree paths.
- [`me group`](me-group.md) -- bundle members for shared grants.
- [`me agent`](me-agent.md) -- add your agents to a space.
