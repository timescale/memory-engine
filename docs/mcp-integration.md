# MCP Integration

Memory Engine integrates with AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). This gives agents tools to store and retrieve knowledge across conversations, plus session tools to inspect and switch the active engine.

## How it works

When an AI tool launches `me mcp`, it spawns a child process that communicates over **stdin/stdout** using the MCP protocol. Each memory tool call is translated into an HTTP request to the Memory Engine API. No memory data is stored locally; the only per-session state is the currently-bound engine and a cache of API clients keyed by engine slug.

```
┌──────────────┐   stdio (JSON-RPC)   ┌──────────┐   HTTPS   ┌────────────────┐
│   AI Agent   │ ◄──────────────────► │  me mcp  │ ────────► │ Memory Engine  │
└──────────────┘                      └──────────┘           └────────────────┘
```

The agent never sees or handles credentials. It just calls MCP tools and gets results back.

### Session state

A session starts in one of two states:

- **BOUND**: launched with `--api-key`. The session is locked to that engine for memory tool calls. This is what the Claude Code plugin and the agent-specific installers do today.
- **FRESH**: launched without `--api-key`. The server reads `~/.config/me/credentials.yaml` so the session can list available engines and bind to one via `me_session_use_engine`. Memory tools error until an engine is bound.

In either state, `me_session_use_engine` can switch the active engine within a session as long as a local API key for the target engine exists in the credentials file. The server URL defaults to `https://api.memory.build` (the hosted engine) but can be overridden with `--server` or `ME_SERVER`.

## Setup

### Prerequisites

You need an API key. Run `me whoami` to see your active engine, or create an API key with `me apikey create`.

The server defaults to `https://api.memory.build`. Pass `--server <url>` only if you're running a self-hosted engine.

### Agent-specific installers

```bash
me opencode install
me codex install
me gemini install
```

These commands register Memory Engine with the named tool. They read your API key and server URL from the credentials file and bake them into the tool's MCP configuration, so the `me mcp` process can authenticate without the credentials file.

See the agent-specific command references for details: [`me opencode install`](cli/me-opencode.md#me-opencode-install), [`me codex install`](cli/me-codex.md#me-codex-install), and [`me gemini install`](cli/me-gemini.md#me-gemini-install).

| Tool | Install command |
|------|-----------------|
| OpenCode | `me opencode install` |
| Codex CLI | `me codex install` |
| Gemini CLI | `me gemini install` |
| Claude Code | Claude Code plugin, described below |

### Claude Code

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine [--scope user|project|local]
```

Claude Code uses the Memory Engine plugin. After installing it, start a Claude Code session, run `/plugin`, select `memory-engine`, and configure `api_key`, `server`, and `tree_prefix`. The plugin provides the MCP server and captures Claude Code session events as memories.

### Gemini CLI

```bash
me gemini install
```

To configure manually:

```bash
gemini mcp add --scope user me me mcp --api-key <key> --server <url>
```

### Codex CLI

```bash
me codex install
```

To configure manually:

```bash
codex mcp add me -- me mcp --api-key <key> --server <url>
```

### OpenCode

`me opencode install` edits `~/.config/opencode/opencode.json` directly, adding an entry under `mcp.me`. To configure manually, add this to that file:

```json
{
  "mcp": {
    "me": {
      "type": "local",
      "command": ["me", "mcp", "--api-key", "<key>", "--server", "<url>"]
    }
  }
}
```

### VS Code / GitHub Copilot

Add a `.vscode/mcp.json` file to your workspace:

```json
{
  "servers": {
    "me": {
      "command": "me",
      "args": ["mcp", "--api-key", "<key>", "--server", "<url>"]
    }
  }
}
```

This makes Memory Engine available to GitHub Copilot in agent mode. Commit this file to share the configuration with your team (use environment variables or input variables for the API key in shared configs).

To configure globally across all workspaces, open the Command Palette and run **MCP: Open User Configuration**.

### Zed

Open your Zed settings (`Zed > Settings > Open Settings` or `~/.config/zed/settings.json`) and add:

```json
{
  "context_servers": {
    "me": {
      "command": "me",
      "args": ["mcp", "--api-key", "<key>", "--server", "<url>"]
    }
  }
}
```

After saving, check the Agent Panel settings — the indicator next to "me" should turn green when the server is active.

### Other MCP clients

Any tool that supports the MCP stdio transport can use Memory Engine. The server command is:

```bash
me mcp --api-key <key> --server <url>
```

Point your client at this command with `stdio` as the transport type.

## Available tools

Once connected, the agent has access to:

### Memory tools

| Tool | Purpose |
|------|---------|
| `me_memory_create` | Store a new memory |
| `me_memory_search` | Search by meaning, keywords, or filters |
| `me_memory_get` | Retrieve a memory by ID |
| `me_memory_update` | Modify an existing memory |
| `me_memory_delete` | Delete a memory |
| `me_memory_delete_tree` | Bulk delete by tree prefix |
| `me_memory_mv` | Move memories between tree paths |
| `me_memory_tree` | View the tree structure |
| `me_memory_import` | Bulk import from file or content |
| `me_memory_export` | Bulk export with filters |

### Session and engine tools

| Tool | Purpose |
|------|---------|
| `me_engine_list` | List engines visible to the active credentials, marking which have a local API key |
| `me_session_get_engine` | Report the engine bound to this session, or FRESH if none |
| `me_session_use_engine` | Bind this session to an engine by slug, name, or ID (per-session, not persisted) |
| `me_session_provision_engine` | Mint and persist an API key for an engine when no local key exists, then bind the session |

See [MCP Tool Reference](mcp/me_memory_search.md) for detailed documentation on each tool.

## The AGENTS.md pattern

The most effective way to use Memory Engine with AI agents is the **AGENTS.md pattern**: put a file called `AGENTS.md` in your project root that teaches the agent how to use memory.

A good AGENTS.md includes:

- **Memory map** -- what's stored where in the tree hierarchy, so the agent knows what to search for.
- **Search examples** -- concrete examples of semantic, fulltext, and hybrid searches.
- **Conventions** -- your tree path structure, metadata conventions, and when to store vs. search.
- **Proactive search instructions** -- tell the agent to search memory before starting work, when making decisions, and after completing work.

### Example

```markdown
# Project Memory

This project uses Memory Engine for persistent knowledge.

## Memory Map

- `design.*` -- architecture decisions and design docs
- `research.*` -- research findings and comparisons
- `bugs.*` -- known issues and workarounds

## How to Search

Search memory proactively:
- Before starting work: search for prior art and context
- When making decisions: check if the topic was decided before
- After completing work: store decisions and findings

## Search Examples

# Hybrid search (recommended: meaning + keywords)
me_memory_search({semantic: "database-generated identifiers", fulltext: "database-generated identifiers"})

# Semantic search (by meaning)
me_memory_search({semantic: "how does authentication work"})

# Keyword search
me_memory_search({fulltext: "OAuth JWT"})

# Browse a section
me_memory_search({tree: "design.*"})
```

## Troubleshooting

### MCP server shows "failed" or "disabled"

1. Verify the `me` binary is on your PATH: `which me`
2. Test the server directly: `echo '{}' | me mcp --api-key <key> --server <url>`
3. Re-install with the agent-specific command, for example `me opencode install`, `me codex install`, or `me gemini install`. For Claude Code, open `/plugin` and reconfigure `memory-engine`.

### Agent can't find memories

1. Check that the correct engine is active: `me whoami`
2. Verify memories exist: `me memory search --fulltext "<keyword>"`
3. Check that embeddings have been computed: `me memory get <id>` (look for `hasEmbedding: true`)
