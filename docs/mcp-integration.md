# MCP Integration

Memory Engine integrates with AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). This gives agents 10 memory tools they can use to store and retrieve knowledge across conversations.

## How it works

When an AI tool launches `me mcp`, it spawns a child process that communicates over **stdin/stdout** using the MCP protocol. The process is a stateless proxy — each tool call is translated into an HTTP request to the Memory Engine API. No data is stored locally.

```
┌──────────────┐   stdio (JSON-RPC)   ┌──────────┐   HTTPS   ┌────────────────┐
│   AI Agent   │ ◄──────────────────► │  me mcp  │ ────────► │ Memory Engine  │
└──────────────┘                      └──────────┘           └────────────────┘
```

Authentication is baked into the command via `--api-key` and `--server` flags. The AI agent never sees or handles credentials — it just calls MCP tools and gets results back.

Each `me mcp` instance is locked to a single engine via its API key. The MCP server does **not** read the credentials file — the API key must be provided via `--api-key` or the `ME_API_KEY` environment variable. The server URL defaults to `https://api.memory.build` (the hosted engine) but can be overridden with `--server` or `ME_SERVER`.

## Setup

### Prerequisites

You need an API key. Run `me whoami` to see your active engine, or create an API key with `me apikey create`.

The server defaults to `https://api.memory.build`. Pass `--server <url>` only if you're running a self-hosted engine.

### Automatic

```bash
me mcp install
```

This detects AI tools on your PATH and registers Memory Engine with each one. It reads your API key and server URL from the credentials file and bakes them into each tool's MCP configuration, so the `me mcp` process can authenticate without the credentials file.

See [`me mcp install`](cli/me-mcp.md) for the full command reference.

| Tool | Detection |
|------|-----------|
| Claude Code | `claude` binary |
| Gemini CLI | `gemini` binary |
| Codex CLI | `codex` binary |
| OpenCode | `opencode` binary (manual setup) |

### Claude Code

```bash
claude mcp add --scope user me -- me mcp --api-key <key> --server <url>
```

This registers `me` as a user-scoped MCP server. Claude Code will start the `me mcp` process automatically in every conversation.

### Gemini CLI

```bash
gemini mcp add --scope user me me mcp --api-key <key> --server <url>
```

### Codex CLI

```bash
codex mcp add me -- me mcp --api-key <key> --server <url>
```

### OpenCode

```bash
opencode mcp add
```

Follow the interactive prompts to add the `me mcp` command.

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
3. Re-install: `me mcp install`

### Agent can't find memories

1. Check that the correct engine is active: `me whoami`
2. Verify memories exist: `me memory search --fulltext "<keyword>"`
3. Check that embeddings have been computed: `me memory get <id>` (look for `hasEmbedding: true`)
