# me grant

Manage tree grants.

Grants control access to memories by tree path. A grant gives a user specific actions (read, write, create, delete, admin) on a tree path and all its descendants.

## Commands

- [me grant create](#me-grant-create) -- grant tree access to a user
- [me grant revoke](#me-grant-revoke) -- revoke tree access
- [me grant list](#me-grant-list) -- list grants
- [me grant check](#me-grant-check) -- check if a user has access

---

## me grant create

Grant tree access to a user.

```
me grant create <user> <path> <actions...> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | yes | User name or ID. |
| `path` | yes | Tree path to grant access to. |
| `actions...` | yes | One or more actions: `read`, `write`, `create`, `delete`, `admin`. |

| Option | Description |
|--------|-------------|
| `--with-grant-option` | Allow the grantee to re-grant this access to others. |

### Example

```bash
me grant create alice work.projects read write create
```

---

## me grant revoke

Revoke tree access from a user.

```
me grant revoke <user> <path>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | yes | User name or ID. |
| `path` | yes | Tree path to revoke access from. |

---

## me grant list

List grants.

```
me grant list [user]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | no | Filter by user name or ID. |

Displays a table of grants with user, tree path, actions, and grant option.

---

## me grant check

Check if a user has access to a tree path.

```
me grant check <user> <path> <action>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | yes | User name or ID. |
| `path` | yes | Tree path. |
| `action` | yes | Action to check: `read`, `write`, `create`, `delete`, `admin`. |

Reports whether access is allowed or denied.
