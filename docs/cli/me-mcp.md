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
| `--api-key <key>` | API key. If omitted, the server uses your stored `me login` session. |
| `--space <slug>` | Lock MCP to this space (the `X-Me-Space`). |

Resolution order:

- **Auth token**: `--api-key` > `ME_API_KEY` > stored session token.
- **Space**: `--space` > `ME_SPACE`; without either, MCP is multi-space.
- **Server URL**: `--server` (global option) > `ME_SERVER` > `https://api.memory.build`.

A logged-in developer needs no key or space. `--space` and `ME_SPACE` create a locked server: memory tools cannot select another space. Without either, MCP starts multi-space mode: `me_space_list` is available and memory tools require `space`. Project configuration and your stored active space do not select an MCP space. This supports manual configuration without `.me/config.yaml` or an active space, for example `me mcp --api-key <key> --server <url>`. Selecting a space never grants access; the server still enforces membership and tree grants. The server acts as the principal represented by that credential.

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

Then start Claude Code, run `/plugin`, select `memory-engine`, and configure the options (all optional): leave `api_key` and `server` blank to use your `me login` session and server; leave `space` blank for multi-space MCP tools or set it to lock MCP and pin captures. Set `content_mode` to control how much of each message is captured. The plugin has no tree setting — where captured sessions are stored is controlled by your project's [`.me/config.yaml`](../project-config.md) `tree` (or the private `~/projects` default). See [`me claude`](me-claude.md) for the full plugin reference.
