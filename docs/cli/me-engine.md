# me engine

Manage engines.

An engine is an isolated memory database. Each engine has its own memories, users, roles, grants, and API keys.

## Commands

- [me engine list](#me-engine-list) -- list engines across all your organizations
- [me engine use](#me-engine-use) -- select the active engine
- [me engine create](#me-engine-create) -- create a new engine
- [me engine delete](#me-engine-delete) -- permanently delete an engine

---

## me engine list

List engines across all your organizations.

```
me engine list
```

Displays a table of all engines you have access to, showing ID, name, slug, organization, and status. The active engine is marked.

---

## me engine use

Select the active engine.

```
me engine use [id-or-name]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-name` | no | Engine ID or name. If omitted, an interactive picker is shown. |

Switches the active engine. If no API key exists for the engine, one is created automatically. The active engine is used by all subsequent commands that interact with memories.

---

## me engine create

Create a new engine in an organization.

```
me engine create <name> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Engine name. |

| Option | Description |
|--------|-------------|
| `--org <id>` | Organization ID. If omitted, an interactive picker is shown. |
| `--language <lang>` | Text search language (default: `english`). |

---

## me engine delete

Permanently delete an engine and all its data.

```
me engine delete <id-or-name> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id-or-name` | yes | Engine ID or name. |

| Option | Description |
|--------|-------------|
| `--force` | Skip the confirmation prompt. |

You will be asked to type the engine name to confirm unless `--force` is used. This operation is irreversible.
