# me apikey

Manage API keys.

API keys are how **agents** authenticate. Each key belongs to one of your agents and is **global** — not bound to a space. The same key works in any space the agent has been admitted to; the space comes from the `X-Me-Space` header (`--space` / `ME_SPACE`). Keys are formatted `me.<lookupId>.<secret>`.

Humans authenticate with a session (`me login`), not an API key. These commands authenticate with your **session**.

The CLI never persists API keys. A created key is printed **once** for you to place where the agent runs (typically via the `ME_API_KEY` environment variable). The alias `me apikey revoke` is equivalent to `me apikey delete`.

## Commands

- [me apikey create](#me-apikey-create) -- mint a key for an agent
- [me apikey list](#me-apikey-list) -- list an agent's keys
- [me apikey get](#me-apikey-get) -- show key metadata
- [me apikey delete](#me-apikey-delete) -- delete (revoke) a key

---

## me apikey create

Mint a new API key for one of your agents. The raw key is shown only once — store it securely.

```
me apikey create <agent> [name] [--expires <timestamp>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |
| `name` | no | Key name (auto-generated if omitted). |

| Option | Description |
|--------|-------------|
| `--expires <timestamp>` | Expiration timestamp (ISO 8601). |

---

## me apikey list

List an agent's API keys (metadata only — never the secret). Alias: `me apikey ls`.

```
me apikey list <agent>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |

Displays a table of keys with ID, name, last-used date, and expiry.

---

## me apikey get

Show metadata for a single API key.

```
me apikey get <id>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | API key ID. |

---

## me apikey delete

Permanently delete (revoke) an API key. There is no soft-revoke state — delete is the only way to invalidate a key. Irreversible. Aliases: `me apikey rm`, `me apikey revoke`.

```
me apikey delete <id> [-y]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | API key ID. |

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip the confirmation prompt. |

## See also

- [`me agent`](me-agent.md) -- create the agents that hold these keys and add them to spaces.
- [MCP Integration](../mcp-integration.md) -- supply a key to an MCP-connected agent via `--api-key` or `ME_API_KEY`.
