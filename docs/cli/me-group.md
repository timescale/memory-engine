# me group

Manage groups in the active space.

A **group** is a named bundle of members (users and agents). Membership is **transitive**: a group member inherits the group's space membership, its admin flag (if the group is an admin), and all of its tree-access grants. Grant access to a group once and every member gets it.

These commands authenticate with your **session** and operate on the active space.

## Commands

- [me group list](#me-group-list) -- list groups in the space
- [me group mine](#me-group-mine) -- list the groups you're in
- [me group create](#me-group-create) -- create a group
- [me group rename](#me-group-rename) -- rename a group
- [me group delete](#me-group-delete) -- delete a group
- [me group add](#me-group-add) -- add a member
- [me group remove](#me-group-remove) -- remove a member
- [me group members](#me-group-members) -- list a group's members

---

## me group list

List groups in the active space. Alias: `me group ls`.

```
me group list
```

---

## me group mine

List the groups you are a member of in the active space.

```
me group mine
```

---

## me group create

Create a group.

```
me group create <name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Group name. |

---

## me group rename

Rename a group.

```
me group rename <group> <new-name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `group` | yes | Group id or name. |
| `new-name` | yes | New name. |

---

## me group delete

Delete a group. Alias: `me group rm`.

```
me group delete <group>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `group` | yes | Group id or name. |

---

## me group add

Add a member (user or agent) to a group.

```
me group add <group> <member> [--admin]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `group` | yes | Group id or name. |
| `member` | yes | User or agent id or name. |

| Option | Description |
|--------|-------------|
| `--admin` | Make them a group admin (can manage the group's membership). |

---

## me group remove

Remove a member from a group. Alias: `me group rm-member`.

```
me group remove <group> <member>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `group` | yes | Group id or name. |
| `member` | yes | User or agent id or name. |

---

## me group members

List a group's members.

```
me group members <group>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `group` | yes | Group id or name. |

## See also

- [`me access`](me-access.md) -- grant a group access to a tree path.
- [Access Control](../access-control.md) -- transitive membership and the authority model.
