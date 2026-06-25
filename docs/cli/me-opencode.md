# me opencode

OpenCode integration commands.

## Commands

- [me opencode install](#me-opencode-install) -- register `me` as an MCP server with OpenCode
- [me opencode import](#me-opencode-import) -- import OpenCode sessions from `~/.local/share/opencode/storage`

---

## me opencode install

Register `me` as an MCP server with OpenCode by editing `~/.config/opencode/opencode.json`.

```
me opencode install [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key for a headless agent. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Server URL to embed in the MCP config. |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login) and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create --agent <agent>`, or `me apikey create` for a personal access token) for a headless agent that cannot reach your keychain; that bakes the key and requires a pinned `--space`.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me opencode import

Import OpenCode sessions from `~/.local/share/opencode/storage/`. This is an alias of [`me import opencode`](me-import.md#me-import-claude--codex--opencode).

```
me opencode import [options]
```

See [agent session imports](agent-session-imports.md) for the full option reference, tree layout, idempotency rules, content shape, and metadata schema.

OpenCode stores data across four directories:

- `project/<project-id>.json` -- project metadata
- `session/<project-id>/ses_<id>.json` -- session metadata (title, directory, timestamps)
- `message/ses_<id>/msg_<id>.json` -- per-message metadata (role, model)
- `part/msg_<id>/prt_<id>.json` -- content parts (text, reasoning, tool, step-start/finish)

Each `msg_<id>` becomes one memory. Parts are stitched into the message's ordered block list (text / reasoning / tool_use + tool_result). OpenCode's `agent` field becomes `meta.source_agent_mode` (e.g. `"plan"`).

Synthetic OpenCode user text wrapper parts marked with `synthetic: true` are ignored.
