# me apikey

Manage API keys — your own **personal access token (PAT)**, or a key for one of your **agents** (`--agent`).

An API key is a global, per-principal credential — **not** bound to a space. The same key works in any space its principal has been admitted to; the space comes from the `X-Me-Space` header (`--space` / `ME_SPACE`). Keys are formatted `me.<lookupId>.<secret>`.

There are two kinds, distinguished only by who they act as:

- **Personal access token** (default) — acts as **you**, for headless/CLI use (a VM, SSH, CI) where your `me login` session isn't available. Full access as you, but it **cannot** manage keys (minting/revoking always needs a session).
- **Agent key** (`--agent <agent>`) — acts as one of your agents, for a dedicated/unattended agent install.

Minting and revoking keys authenticate with your **session** (`me login`); an API key can't mint or revoke keys. The CLI never persists API keys — a created key is printed **once** for you to place where it's used (typically the `ME_API_KEY` environment variable). The alias `me apikey revoke` is equivalent to `me apikey delete`.

## Commands

- [me apikey create](#me-apikey-create) -- mint a personal access token (or an agent key)
- [me apikey list](#me-apikey-list) -- list your keys (or an agent's)
- [me apikey get](#me-apikey-get) -- show key metadata
- [me apikey delete](#me-apikey-delete) -- delete (revoke) a key

---

## me apikey create

Mint a new API key. With no `--agent`, mints a **personal access token** for yourself; with `--agent`, mints a key for that agent. The raw key is shown only once — store it securely.

```
me apikey create [name] [--agent <agent>] [--expires <timestamp>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | no | Key name (auto-generated as `cli-<date>-<rand>` if omitted). |

| Option | Description |
|--------|-------------|
| `--agent <agent>` | Mint a key for one of your agents (id or name) instead of yourself. |
| `--expires <timestamp>` | Expiration timestamp (ISO 8601). |

Names are unique per principal, so you can't mint two keys with the same name for the same target. The auto-generated default carries a random suffix, so repeated `me apikey create` calls never collide.

```bash
# A personal access token for yourself (e.g. to use headlessly in a VM)
me apikey create
me apikey create my-laptop          # …with a name

# A key for one of your agents
me apikey create --agent claude-code-agent plugin-key
```

---

## me apikey list

List API keys (metadata only — never the secret). With no `--agent`, lists **your own** keys; with `--agent`, lists that agent's keys. Alias: `me apikey ls`.

```
me apikey list [--agent <agent>]
```

| Option | Description |
|--------|-------------|
| `--agent <agent>` | List one of your agents' keys (id or name) instead of your own. |

Displays a table of keys with ID, name, created date, and expiry.

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

- [`me agent`](me-agent.md) -- create the agents that hold `--agent` keys and add them to spaces.
- [MCP Integration](../mcp-integration.md) -- supply a key to an MCP-connected agent via `--api-key` or `ME_API_KEY`.
