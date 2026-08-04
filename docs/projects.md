# Projects

A Memory Engine **project** is a convention for one repository's memories. It is
not a separate object in the server: a project is a tree path, plus the grants
that decide who can write there.

Nothing in the repository configures this. You point a project's captures and
imports at its tree with machine-local, per-directory policy ([`me init`](cli/me-init.md))
and with the `--tree` / `--tree-root` flags on the import commands. The main
choice is where the project's tree should live.

Some layouts need help from a **space admin** or a path owner. You can set up
layouts that use access you already have, but creating groups is admin-gated,
and granting access requires owner access at the target path.

## Common Layouts

| Goal | Project tree | Grants |
|------|--------------|--------|
| Whole team can write project memories | `/share/projects/<project>` | The default `team` group is enough |
| Whole team can read, one group writes | `/share/<group>/<project>` | Grant that group `write` on the group or project path |
| Only one group can read and write | `/<group>/<project>` | Grant that group `write` on the group or project path |
| CI imports git/docs | The selected CI tree | `me ci install` can create a service account and grant it write access |

Project trees are full paths. When a project tree is `/share/projects/acme-api`,
captures and imports land directly under that node:

- `/share/projects/acme-api/agent_sessions`
- `/share/projects/acme-api/git_history`
- `/share/projects/acme-api/docs`

No extra project slug is appended.

## Team-Writable Projects

Use `/share/projects/<project>` when everyone in the space's default `team`
group should be able to write memories for the repo.

Point this directory's session capture at that tree (machine-local; each
teammate runs it once for their own checkout):

```bash
me init . \
  --capture-server https://api.memory.build \
  --capture-space abc123def456 \
  --capture-tree /share/projects/acme-api \
  --capture-harness claude
```

This works in a default space because the auto-provisioned `team` group carries:

- `read@/share`
- `write@/share/projects`

Invitations add new members to `team` by default, so teammates can read shared
knowledge and write under `/share/projects/...` without a per-project grant.
This is the happy path for shared repository memory. One-off imports target the
same tree with `--tree`, e.g. `me import git --tree /share/projects/acme-api`.

## Group-Writable Projects

Use a group path when the whole team may read the project, but only a subgroup
should write it. For example, a payments team might keep projects under
`/share/payments/...`:

Ask a space admin to create the group and add members. Then have someone with
owner access at the target path grant the group write access:

```bash
me group create payments
me group add payments alice@example.com
me group add payments bob@example.com
me access grant payments /share/payments w
```

Then point the repo's capture (and imports) at a tree under that group path,
e.g. `--capture-tree /share/payments/acme-billing`.

The grant at `/share/payments` covers every project below it. If you want one
repo at a time instead, grant the project node directly:

```bash
me access grant payments /share/payments/acme-billing w
```

In a default space, `team` still has `read@/share`, so other teammates can read
the project memories but cannot write them unless they are also in `payments`.

## Group-Private Projects

If the project should not be broadly visible, do not put it under `/share`.
`/share` is the convention for space-wide shared knowledge, and in a default
space the `team` group can read it.

Instead, create a top-level tree for the group and grant only that group access.
A space admin can create the group and add members; granting write access at the
target path requires owner access there.

```bash
me group create group-x
me group add group-x alice@example.com
me group add group-x bob@example.com
me access grant group-x /group-x w
```

Then point the repo's capture at a tree under that node, e.g.
`--capture-tree /group-x/secret-project`. A single write grant is enough when the
same group should both read and write: `write` includes `read`.

Put personal project notes under `~/projects/<project>` when they are only for
you — that private layout is the default when you don't pin a `--capture-tree`.

## CI Imports

For git-history and docs imports, run:

```bash
me ci install
```

CI runs as a service account. Service accounts do not join `team` and do not get
a home tree. When it provisions credentials, `me ci install` creates a write
grant at the selected CI tree; an existing key is verified by the first CI run.

For teams that use `/share/projects/<project>` everywhere, a space admin may
also grant one shared service account `write@/share/projects`. For per-project
or per-group service accounts, grant only the specific project tree.

## Changing a Project Later

To move a repository's future captures, rerun [`me init`](cli/me-init.md) for
that directory with a different `--capture-tree`; for imports, pass a different
`--tree`. Existing memories stay at their old paths until you move or copy them.

Useful checks:

```bash
me doctor
me whoami
me access mine --effective
me tree /share/projects --levels 2
```

See also [`me init`](cli/me-init.md), [`me doctor`](cli/me-doctor.md),
[`me group`](cli/me-group.md), and [`me access`](cli/me-access.md).
