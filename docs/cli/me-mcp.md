# me mcp

MCP server for AI tool integration.

The `me mcp` command runs Memory Engine as a [Model Context Protocol](https://modelcontextprotocol.io/) server over stdio, allowing AI coding agents to store and retrieve memories.

## Commands

- [me mcp](#me-mcp-1) -- run the MCP server

---

## me mcp

Run the MCP server over stdio.

```
me mcp [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | Agent API key. If omitted, the server uses your stored `me login` session. |
| `--space <slug>` | Space to operate in (the `X-Me-Space`). |

Resolution order:

- **Auth token**: `--api-key` > `ME_API_KEY` > stored session token.
- **Space**: `--space` > `ME_SPACE` > stored active space.
- **Server URL**: `--server` (global option) > `ME_SERVER` > `https://api.memory.build`.

A logged-in developer needs no key or space — the active session and active space are used automatically. For an unattended/headless agent, pass `--api-key` and `--space` (or set `ME_API_KEY` / `ME_SPACE`).

This command is typically not run directly -- it is invoked by AI tools based on their MCP configuration.

---

## Installation

MCP registration lives under agent-specific commands — `install` (user scope,
acts as you) or `init` (project scope, acts as the project's `.me` agent):

| Tool | User | Project |
|------|------|---------|
| Claude Code | [`me claude install`](me-claude.md#me-claude-install) | [`me claude init`](me-claude.md#me-claude-init) |
| OpenCode | [`me opencode install`](me-opencode.md#me-opencode-install) | [`me opencode init`](me-opencode.md#me-opencode-init) |
| Codex CLI | [`me codex install`](me-codex.md#me-codex-install) | [`me codex init`](me-codex.md#me-codex-init) |
| Gemini CLI | [`me gemini install`](me-gemini.md#me-gemini-install) | [`me gemini init`](me-gemini.md#me-gemini-init) |

See [MCP Integration](../mcp-integration.md) for the raw config each writes.
