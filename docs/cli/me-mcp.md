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
| `--api-key <key>` | API key for engine authentication. Can also be set via `ME_API_KEY` env var. |

The server URL is resolved from `--server` (global option) > `ME_SERVER` env > `https://api.memory.build`.

This command is typically not run directly -- it is invoked by AI tools based on their MCP configuration.

---

## Installation

MCP registration lives under agent-specific commands:

| Tool | Command |
|------|---------|
| OpenCode | [`me opencode install`](me-opencode.md#me-opencode-install) |
| Codex CLI | [`me codex install`](me-codex.md#me-codex-install) |
| Gemini CLI | [`me gemini install`](me-gemini.md#me-gemini-install) |
| Claude Code | [`me claude`](me-claude.md) plugin hooks |

Claude Code uses the Memory Engine plugin instead of MCP registration through the `me` CLI:

```
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine [--scope user|project|local]
```

Then start Claude Code, run `/plugin`, select `memory-engine`, and configure `api_key`, `server`, and `tree_prefix`.
