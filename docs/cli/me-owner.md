# me owner

Manage tree ownership.

Ownership gives a user implicit admin access to a tree path and all its descendants. Unlike grants, ownership is unique per path -- each path has at most one owner.

## Commands

- [me owner set](#me-owner-set) -- set tree path owner
- [me owner remove](#me-owner-remove) -- remove tree path owner
- [me owner get](#me-owner-get) -- get tree path owner
- [me owner list](#me-owner-list) -- list ownership records

---

## me owner set

Set tree path owner.

```
me owner set <path> <user>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | yes | Tree path. |
| `user` | yes | User name or ID. |

---

## me owner remove

Remove tree path owner.

```
me owner remove <path>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | yes | Tree path. |

---

## me owner get

Get tree path owner.

```
me owner get <path>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | yes | Tree path. |

Displays the path, owner name, set-by, and creation date.

---

## me owner list

List ownership records.

```
me owner list [user]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | no | Filter by user name or ID. |

Displays a table of ownership records with tree path and owner.
