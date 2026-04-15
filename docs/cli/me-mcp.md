# me mcp

MCP server for AI tool integration.

The `me mcp` command runs Memory Engine as a [Model Context Protocol](https://modelcontextprotocol.io/) server over stdio, allowing AI coding agents to store and retrieve memories.

## Commands

- [me mcp](#me-mcp-1) -- run the MCP server
- [me mcp install](#me-mcp-install) -- register with AI tools

---

## me mcp

Run the MCP server over stdio.

```
me mcp [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key for engine authentication. Can also be set via `ME_API_KEY` env var. |

The server URL is resolved from `--server` (global option) > `ME_SERVER` env > `https://memory.build`.

This command is typically not run directly -- it is invoked by AI tools (Claude Code, Gemini CLI, etc.) based on the MCP configuration created by `me mcp install`.

---

## me mcp install

Register `me` as an MCP server with AI tools.

```
me mcp install [tools...] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `tools...` | no | Tool names to install (default: all detected). |

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key to embed in the MCP config. |
| `--server <url>` | Server URL to embed in the MCP config. |

Detects installed AI tools on your PATH and registers `me` as an MCP server with each one. Supported tools:

| Tool | Binary | Method |
|------|--------|--------|
| Claude Code | `claude` | `claude mcp add` |
| Gemini CLI | `gemini` | `gemini mcp add` |
| Codex CLI | `codex` | `codex mcp add` |
| OpenCode | `opencode` | Manual instructions |

If no `--api-key` or `--server` is provided, values are resolved from `~/.config/me/credentials.yaml` (set by `me login` and `me engine use`).

### Example

```bash
# Install for all detected tools using stored credentials
me mcp install

# Install for Claude Code only with explicit credentials
me mcp install claude --api-key me.xxx --server https://memory.build
```
