# me apikey

Manage API keys.

API keys authenticate users to an engine. Each key is scoped to a single user and can be used for MCP server connections, CLI authentication, and direct API access.

## Commands

- [me apikey list](#me-apikey-list) -- list API keys for a user
- [me apikey create](#me-apikey-create) -- create a new API key
- [me apikey show](#me-apikey-show) -- show a stored API key from credentials.yaml
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

## me apikey show

Show the API key stored locally in `credentials.yaml` for an engine. Reads only — no network call.

```
me apikey show [options]
```

| Option | Description |
|--------|-------------|
| `--engine <slug>` | Engine slug to look up. Defaults to the active engine for the resolved server. |

The active server is resolved in the usual order (`--server` flag > `ME_SERVER` env > `default_server` in `credentials.yaml`). The active engine comes from that server's `active_engine` entry; switch it with `me engine use <slug>` or override per-call with `--engine`.

Errors when no engine can be resolved or when the named engine has no stored API key.

Useful for scripting:

```sh
export ME_API_KEY=$(me apikey show --json | jq -r .apiKey)
```

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
