# me access

Manage tree-access grants in the active space.

A grant attaches an access **level** to a principal (user, agent, or group) at a **tree path**. Levels are additive and hierarchical — a grant at `/share/work` also covers everything below it:

| Level | Flag | Capabilities |
|-------|------|--------------|
| read | `r` | Search and retrieve memories at or below the path. |
| write | `w` | Read + create, update, move, and delete memories. |
| owner | `o` | Write + manage access (grant/revoke) within the subtree. |

`owner` at the empty (root) path owns the whole space. Granting access requires `owner` on the path in question (an admin can self-grant `owner@root`). See [Access Control](../access-control.md).

These commands authenticate with your **session** and operate on the active space.

## Commands

- [me access grant](#me-access-grant) -- grant or update access at a path
- [me access rm-grant](#me-access-rm-grant) -- remove a grant
- [me access list](#me-access-list) -- list grants

---

## me access grant

Grant or update a principal's access at a tree path.

```
me access grant <principal> <path> <level>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `principal` | yes | Principal id or name (user email, agent name, or group name). |
| `path` | yes | Tree path; use an empty string `""` for the space root. |
| `level` | yes | Access level: `r` (read), `w` (write), or `o` (owner). |

```bash
me access grant alice@example.com /share/work r
me access grant backend /share/work/api w
me access grant lead@example.com "" o          # owner@root — whole space
```

---

## me access rm-grant

Remove a principal's grant at a tree path.

```
me access rm-grant <principal> <path>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `principal` | yes | Principal id or name. |
| `path` | yes | Tree path of the grant to remove. |

---

## me access list

List grants in the active space, optionally scoped to one principal and/or a path subtree. Alias: `me access ls`.

```
me access list [principal] [--path <path>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `principal` | no | Filter to a single principal (id or name). |

| Option | Description |
|--------|-------------|
| `--path <path>` | Only grants at or below this tree path. |

## See also

- [`me group`](me-group.md) -- grant to a group so all members inherit access.
- [`me space invite`](me-space.md#me-space-invite) -- set a new member's shared-root access at invite time.
