# Projects

A Memory Engine **project** is a convention for memories from one repository.
It is not a separate server object and it does not require repository
configuration. A project is a tree path plus the access grants that control who
can use that path.

Use `me init` from a repository to configure machine-local capture and harness
policy for that directory. Use [Harness Integrations](harness-integrations.md)
for the installation and policy model.

## Choose A Project Tree

The main decision is whether project knowledge is shared or private.

| Goal | Project tree | Typical access |
| --- | --- | --- |
| Team-shared repository knowledge | `/share/projects/<project>` | Members with write access under `/share/projects` |
| Shared visibility, subgroup writes | `/share/<group>/<project>` | Team reads `/share`; subgroup receives write access |
| Group-private repository knowledge | `/<group>/<project>` | Only the group receives access |
| Personal repository knowledge | `~/projects/<project>` | Your home-tree access |
| CI imports | A shared project tree | Service account receives write access at that tree |

When quick setup enables capture, it suggests `/share/projects/<repository>`.
Choose `~/projects/<repository>` at the prompt when captures should remain
private. Use `me init --verbose` to choose a different tree or configure capture
separately from MCP and CLI routing.

Project trees are full paths. For `/share/projects/acme-api`, common child nodes
include:

- `/share/projects/acme-api/agent_sessions`
- `/share/projects/acme-api/git_history`
- `/share/projects/acme-api/docs`

No additional repository slug is appended to a tree you explicitly choose.

## Team-Shared Projects

`/share/projects/<project>` is the usual destination for repository knowledge
the whole space should be able to read and contribute to.

Default spaces commonly provision a default group with read access to `/share`
and write access to `/share/projects`. That is a convention of the default space
setup, not a guarantee for every custom space. Check your effective access
before relying on it:

```bash
me access mine --effective
me tree /share/projects --levels 2
```

For a repository named `acme-api`, run `me init` and accept or enter:

```text
/share/projects/acme-api
```

The same full tree can be used for one-off imports:

```bash
me import git --tree /share/projects/acme-api
me import docs . --tree /share/projects/acme-api
```

## Subgroup-Writable Projects

Use a subgroup path when everyone may read a project but only selected members
should write it. A space admin creates and manages the group; a path owner grants
the group's access:

```bash
me group create payments
me group add payments alice@example.com
me group add payments bob@example.com
me access grant payments /share/payments w
```

Then configure the repository to use a child tree such as
`/share/payments/acme-billing`. A grant at `/share/payments` covers every
project below it. Grant the individual project path when access should be scoped
to one repository only.

## Private Group And Personal Projects

Do not place a private group project under `/share` when the wider space should
not read it. Instead, create a separate tree and grant only that group:

```bash
me group create group-x
me group add group-x alice@example.com
me group add group-x bob@example.com
me access grant group-x /group-x w
```

Configure a project below that tree, for example
`/group-x/secret-project`.

For personal notes and private captures, use `~/projects/<project>`. A home tree
is private by default, subject to any access you explicitly grant to others.

## CI Imports

Use `me ci install` from a GitHub repository to create an import workflow for
git history and Markdown documentation:

```bash
me ci install
```

CI runs with a service-account key. Service accounts do not have a home tree, so
their destination must be a shared or otherwise explicitly granted project tree.
When `me ci install` creates credentials, it grants write access at the selected
tree. See [`me ci`](cli/me-ci.md) for workflow and credential details.

## Change A Project Later

Rerun `me init` in the repository to update its quick configuration, or use
`me init --verbose` to choose a different capture tree while preserving precise
control of the other surfaces. Existing memories stay at their original paths;
changing future capture or import destinations does not move them.

Useful checks:

```bash
me doctor
me whoami
me access mine --effective
```

See also [Harness Integrations](harness-integrations.md), [`me init`](cli/me-init.md),
[`me access`](cli/me-access.md), and [`me group`](cli/me-group.md).
