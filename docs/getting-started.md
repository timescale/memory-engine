# Getting Started

Memory Engine is permanent memory for AI agents. Store, search, and organize knowledge that persists across conversations.

## Install

```bash
curl -fsSL https://install.memory.build | sh
```

This installs the `me` binary to `~/.local/bin`. Make sure it's on your PATH.

## Sign up and log in

```bash
me login
```

This starts an OAuth flow via GitHub -- authorize in your browser and the CLI stores your session.

If your CLI is older than the server (or vice versa), `me login` will tell you and bail out before sending you to the browser. You can run the same check explicitly:

```bash
me version
```


## Store your first memory

```bash
me memory create "PostgreSQL 18 supports native UUIDv7 generation." \
  --tree notes.postgres \
  --meta '{"topic": "database"}'
```

## Search

```bash
# Hybrid search (recommended default: meaning + keywords)
me memory search "UUID generation in Postgres"

# Keyword search
me memory search --fulltext "UUIDv7"

# Pure semantic search (by meaning only)
me memory search --semantic "database-generated identifiers"
```

## Browse the tree

```bash
me memory tree
```

## Browse in the web UI

For a richer, visual experience:

```bash
me serve
```

Starts a local web UI on `http://127.0.0.1:3000` (or the next free port) with a tree explorer, hybrid / advanced search, rendered Markdown viewer, and a Monaco-based editor for content + metadata. See [`me serve`](cli/me-serve.md) for details.

## Connect to AI tools

Register Memory Engine with your AI coding tools:

```bash
me opencode install
me codex install
me gemini install
```

For Claude Code, install the Memory Engine plugin instead:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install memory-engine@memory-engine
```

Then start Claude Code, run `/plugin`, select `memory-engine`, and configure `api_key`, `server`, and `tree_prefix`.

After installation, your AI agent has access to memory tools -- create, search, get, update, delete, and more.

See [MCP Integration](mcp-integration.md) for details.

## What's next

- [Core Concepts](concepts.md) -- understand memories, tree paths, metadata, search modes
- [Access Control](access-control.md) -- users, roles, grants, and ownership
- [Memory Packs](memory-packs.md) -- install pre-built knowledge collections
- [MCP Integration](mcp-integration.md) -- how AI agents use Memory Engine
- [CLI Reference](cli/me-memory.md) -- full command reference
- [MCP Tool Reference](mcp/me_memory_search.md) -- full MCP tool reference
