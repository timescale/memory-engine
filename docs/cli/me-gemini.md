# me gemini

Gemini CLI integration commands.

## Commands

- [me gemini install](#me-gemini-install) -- register `me` as an MCP server with Gemini CLI

---

## me gemini install

Register `me` as an MCP server with Gemini CLI.

```
me gemini install [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key to embed in the MCP config. |
| `--server <url>` | Server URL to embed in the MCP config. |

If no `--api-key` or `--server` is provided, values are resolved from `~/.config/me/credentials.yaml` (set by `me login` and `me engine use`).

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).
