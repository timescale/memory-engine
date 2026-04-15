# me apikey

Manage API keys.

API keys authenticate users to an engine. Each key is scoped to a single user and can be used for MCP server connections, CLI authentication, and direct API access.

## Commands

- [me apikey list](#me-apikey-list) -- list API keys for a user
- [me apikey create](#me-apikey-create) -- create a new API key
- [me apikey revoke](#me-apikey-revoke) -- revoke an API key
- [me apikey delete](#me-apikey-delete) -- permanently delete an API key

---

## me apikey list

List API keys for a user.

```
me apikey list <user>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | yes | User name or ID. |

Displays a table of API keys with ID, name, last used date, and status.

---

## me apikey create

Create a new API key.

```
me apikey create <user> [name] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `user` | yes | User name or ID. |
| `name` | no | Key name (auto-generated if omitted). |

| Option | Description |
|--------|-------------|
| `--expires <timestamp>` | Expiration timestamp (ISO 8601). |

The raw key value is displayed only once at creation time. Store it securely.

---

## me apikey revoke

Revoke an API key.

```
me apikey revoke <id>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | API key ID. |

Revokes the key (makes it inactive). The key record is retained but can no longer be used for authentication.

---

## me apikey delete

Permanently delete an API key.

```
me apikey delete <id> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | API key ID. |

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip the confirmation prompt. |

This operation is irreversible.
