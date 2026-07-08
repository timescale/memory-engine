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

**Agent-by-config**: unless `--api-key`/`ME_API_KEY` is already an agent key, `me mcp` resolves an agent from the project's [`.me/config.yaml`](../project-config.md#agent-by-config-and-the-agent-field) `agent`, else your global config's `agent`, and sends every request as that agent (`X-Me-As-Agent`) — validated eagerly at startup with one `whoami` round trip, so a misconfigured agent fails the server at launch instead of every tool call 403ing. With no agent in scope anywhere, `me mcp` refuses to start (see the linked section for the `.user` opt-out).

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

Then start Claude Code, run `/plugin`, select `memory-engine`, and configure the options (all optional except `server`): leave `api_key` blank to use your `me login` session, leave `space` blank to use your active space, and `tree_root` defaults to `/share/projects`.
