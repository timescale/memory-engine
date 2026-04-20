# me role

Manage roles.

Roles are groups of users within an engine. Grant access to a role and all its members inherit that access. Roles cannot authenticate directly -- they are used purely for grouping.

## Commands

- [me role create](#me-role-create) -- create a role
- [me role delete](#me-role-delete) -- delete a role
- [me role list](#me-role-list) -- list all roles
- [me role add-member](#me-role-add-member) -- add a user to a role
- [me role remove-member](#me-role-remove-member) -- remove a user from a role
- [me role members](#me-role-members) -- list members of a role
- [me role list-for](#me-role-list-for) -- list roles a user belongs to

---

## me role create

Create a role.

```
me role create <name> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Role name. |

| Option | Description |
|--------|-------------|
| `--identity-id <id>` | Link to an accounts identity. |

---

## me role delete

Delete a role. Alias: `me role rm`.

```
me role delete <id-or-name> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-name` | yes | Role ID or name. |

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt. |

Deleting a role removes all grants and membership associations. This is irreversible.

---

## me role list

List all roles.

```
me role list
```

Displays a table of roles with ID and name.

---

## me role add-member

Add a user to a role.

```
me role add-member <role> <member> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `role` | yes | Role ID or name. |
| `member` | yes | User ID or name. |

| Option | Description |
|--------|-------------|
| `--with-admin-option` | Allow the member to manage this role. |

---

## me role remove-member

Remove a user from a role.

```
me role remove-member <role> <member>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `role` | yes | Role ID or name. |
| `member` | yes | User ID or name. |

---

## me role members

List members of a role.

```
me role members <role>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `role` | yes | Role ID or name. |

Displays a table of members with ID, name, and admin status.

---

## me role list-for

List roles a user belongs to.

```
me role list-for <user>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | yes | User ID or name. |

Displays a table of roles with ID, name, and admin status.
