# me user

Manage engine users.

Users are principals within an engine that can own memories, receive grants, and authenticate via API keys. Each user belongs to a single engine.

## Commands

- [me user list](#me-user-list) -- list users
- [me user create](#me-user-create) -- create a user
- [me user get](#me-user-get) -- get a user by ID or name
- [me user delete](#me-user-delete) -- delete a user
- [me user rename](#me-user-rename) -- rename a user

---

## me user list

List users in the active engine.

```
me user list [options]
```

| Option | Description |
|--------|-------------|
| `--login-only` | Only show users that can log in (excludes roles). |

Displays a table of users with ID, name, and flags (superuser, createrole, role).

---

## me user create

Create an engine user.

```
me user create <name> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | User name. |

| Option | Description |
|--------|-------------|
| `--superuser` | Grant superuser privileges. |
| `--createrole` | Allow this user to create other users and roles. |
| `--no-login` | Create as a role (cannot authenticate directly). |
| `--identity-id <id>` | Link to an accounts identity. |

---

## me user get

Get a user by ID or name.

```
me user get <id-or-name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-name` | yes | User ID (UUIDv7) or name. |

Displays full user details: name, ID, superuser, createrole, canLogin, identity, and creation date.

---

## me user delete

Delete a user.

```
me user delete <id-or-name> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-name` | yes | User ID or name. |

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip the confirmation prompt. |

This operation is irreversible.

---

## me user rename

Rename a user.

```
me user rename <id-or-name> <new-name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-name` | yes | User ID or current name. |
| `new-name` | yes | New name. |
