# Getting Started

Memory Engine is permanent memory for AI agents. Store, search, and organize knowledge that persists across conversations.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/timescale/memory-engine/main/install.sh | sh
```

This installs the `me` binary to `~/.local/bin`. Make sure it's on your PATH.

## Sign up and log in

```bash
me login
```

This starts an OAuth flow -- choose Google or GitHub, authorize in your browser, and the CLI stores your session.


## Store your first memory

```bash
me memory create "PostgreSQL 18 supports native UUIDv7 generation." \
  --tree notes.postgres \
  --meta '{"topic": "database"}'
```

## Search

```bash
# Semantic search (by meaning)
me memory search "UUID generation in Postgres"

# Keyword search
me memory search --fulltext "UUIDv7"

# Hybrid (both combined)
me memory search --semantic "UUID generation" --fulltext "PostgreSQL 18"
```

## Browse the tree

```bash
me memory tree
```

## Connect to AI tools

Register Memory Engine as an MCP server with your AI coding tools:

```bash
me mcp install
```

This auto-detects Claude Code, Gemini CLI, Codex CLI, and OpenCode on your PATH and registers `me` with each one. After installation, your AI agent has access to 10 memory tools -- create, search, get, update, delete, and more.

See [MCP Integration](mcp-integration.md) for details.

## What's next

- [Core Concepts](concepts.md) -- understand memories, tree paths, metadata, search modes
- [Access Control](access-control.md) -- users, roles, grants, and ownership
- [Memory Packs](memory-packs.md) -- install pre-built knowledge collections
- [MCP Integration](mcp-integration.md) -- how AI agents use Memory Engine
- [CLI Reference](cli/me-memory.md) -- full command reference
- [MCP Tool Reference](mcp/me_memory_search.md) -- full MCP tool reference
