# me service

Manage service accounts in the active space.

A **service account** is a space-scoped operational identity for CI/CD jobs, webhooks, and team-owned integrations. It authenticates with API keys minted through [`me apikey create --service`](me-apikey.md), and those keys should be handled like production secrets.

Each service account has a bound admin group. Space admins can manage all service accounts; direct user members of a service account's bound admin group can administer that service account where allowed by policy. Users, agents, and service accounts may all be members of the bound group for normal group access. The service account is not automatically added to its bound admin group.

## Commands

- [me service list](#me-service-list) -- list service accounts in the active space
- [me service create](#me-service-create) -- create a service account
- [me service rename](#me-service-rename) -- rename a service account
- [me service delete](#me-service-delete) -- delete a service account

---

## me service list

List service accounts visible to you in the active space. Alias: `me service ls`.

```
me service list
```

---

## me service create

Create a service account in the active space. The command prints the service-account id and the bound admin group id.

```
me service create <name> [--admin <member>] [--group-admin <member>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Service account name, unique in the active space. |

| Option | Description |
|--------|-------------|
| `--admin <member>` | Add an initial user, agent, or service account to the bound admin group. Repeatable. |
| `--group-admin <member>` | Add an initial user, agent, or service account with the group's admin flag. Repeatable. |

Members can be referenced by id or resolvable name in the active space.

```bash
me service create deploy-bot --admin ops@example.com
me apikey create --service deploy-bot ci-key
```

---

## me service rename

Rename a service account.

```
me service rename <service> <new-name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `service` | yes | Service account id or name. |
| `new-name` | yes | New service account name. |

---

## me service delete

Delete a service account and its bound admin group. Its API keys are deleted with it. Alias: `me service rm`.

```
me service delete <service> [-y]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `service` | yes | Service account id or name. |

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip the confirmation prompt. |

## See also

- [`me apikey`](me-apikey.md) -- mint, list, and revoke service-account API keys.
- [`me group`](me-group.md) -- manage membership of the bound admin group or ordinary groups.
- [`me access`](me-access.md) -- grant tree access directly to the service account or to a group it belongs to.
