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
| `--api-key <key>` | API key to embed in the MCP config. |
| `--server <url>` | Server URL to embed in the MCP config. |

If no `--api-key` or `--server` is provided, values are resolved from `~/.config/me/credentials.yaml` (set by `me login` and `me engine use`).

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me opencode import

Import OpenCode sessions from `~/.local/share/opencode/storage/`.

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
