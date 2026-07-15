# Projects

A Memory Engine **project** is a convention for one repository's memories. It is
not a separate object in the server: a project is a tree path, usually recorded
in the repo's `.me/config.yaml`, plus the grants that decide who can write there.

Run [`me project init`](cli/me-project.md) from a repository to write the project
config, set up an agent, enable capture, and optionally configure CI imports.
The main choice is where the project's tree should live.

Some layouts need a **space admin** to set up the grants first. You can run the
project wizard yourself for layouts that use access you already have, but
creating groups and granting access to them are admin-gated operations.

## Common Layouts

| Goal | Project tree | Grants |
|------|--------------|--------|
| Whole team can write project memories | `/share/projects/<project>` | The default `team` group is enough |
| Whole team can read, one group writes | `/share/<group>/<project>` | Grant that group `write` on the group or project path |
| Only one group can read and write | `/<group>/<project>` | Grant that group `write` on the group or project path |
| CI imports git/docs | The same project tree | `me project ci` creates or verifies service-account write access |

Project trees are full paths. If `.me/config.yaml` says
`tree: /share/projects/acme-api`, captures and imports land under that node:

- `/share/projects/acme-api/agent_sessions`
- `/share/projects/acme-api/git_history`
- `/share/projects/acme-api/docs`

No extra project slug is appended.

## Team-Writable Projects

Use `/share/projects/<project>` when everyone in the space's default `team`
group should be able to write memories for the repo.

```bash
me project init
```

Choose the public location:

```yaml
# .me/config.yaml
tree: /share/projects/acme-api
```

This works in a default space because the auto-provisioned `team` group carries:

- `read@/share`
- `write@/share/projects`

Invitations add new members to `team` by default, so teammates can read shared
knowledge and write under `/share/projects/...` without a per-project grant.
This is the happy path for shared repository memory.

## Group-Writable Projects

Use a group path when the whole team may read the project, but only a subgroup
should write it. For example, a payments team might keep projects under
`/share/payments/...`:

Ask a space admin to create the group, add members, and grant it write access:

```bash
me group create payments
me group add payments alice@example.com
me group add payments bob@example.com
me access grant payments /share/payments w
```

Then configure the repo with a custom project tree:

```yaml
# .me/config.yaml
tree: /share/payments/acme-billing
```

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

Instead, create a top-level tree for the group and grant only that group access:
these setup steps require a space admin.

```bash
me group create group-x
me group add group-x alice@example.com
me group add group-x bob@example.com
me access grant group-x /group-x w
```

Then configure the repo under that tree:

```yaml
# .me/config.yaml
tree: /group-x/secret-project
```

A single write grant is enough when the same group should both read and write:

```bash
me access grant group-x /group-x w
```

Put personal project notes under `~/projects/<project>` when they are only for
you.

## Project Agents

`me project init` writes an `agent:` field so AI tools can act as a dedicated
agent for the repo. Agents are owned by individual users, so a committed agent
name works for the teammate who created it. Other teammates should run
`me project init` too, choosing an existing agent or creating their own.

When creating a new agent, choose the scope that matches the project layout:

- **Whole-space agent** — useful when you want one agent to work across all
  project trees you can access.
- **Project-only agent** — grants the agent write access only at this project's
  tree.

Agent access is still capped by the owner's access, so an agent cannot write a
group-writable project unless its owner can write that project too.

## CI Imports

For git-history and docs imports, run:

```bash
me project ci
```

CI runs as a service account, not as a human or agent. Service accounts do not
join `team` and do not get a home tree, so `me project ci` creates or verifies a
write grant for the service account at the configured project tree.

For teams that use `/share/projects/<project>` everywhere, a space admin may
also grant one shared service account `write@/share/projects`. For per-project
or per-group service accounts, grant only the specific project tree.

## Changing a Project Later

To move a repository's future captures and imports, edit `.me/config.yaml` or
rerun `me project init` and choose a different tree. Existing memories stay at
their old paths until you move or copy them.

Useful checks:

```bash
me whoami
me access mine --effective
me tree /share/projects --levels 2
```

See also [Project config](project-config.md), [`me project`](cli/me-project.md),
[`me group`](cli/me-group.md), and [`me access`](cli/me-access.md).
