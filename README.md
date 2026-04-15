# Memory Engine

Permanent memory for AI agents. Store, search, and organize knowledge across conversations.

Memory Engine gives AI coding agents a persistent memory layer they can read from and write to via MCP. Memories are organized with tree paths, tagged with metadata, and searchable by meaning (semantic), keywords (BM25), or both (hybrid via Reciprocal Rank Fusion).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/timescale/memory-engine/main/install.sh | sh
```

## Quick start

```bash
# Authenticate
me login

# Store a memory
me memory create "Auth uses bcrypt with cost 12" --tree design.auth

# Search by meaning
me memory search "how does authentication work"

# Connect to your AI tools (Claude Code, Gemini, Codex, OpenCode)
me mcp install
```

## How it works

Memory Engine runs as an MCP server that AI agents connect to over stdio. Each agent gets 10 tools for creating, searching, and managing memories. All data lives in PostgreSQL, using native extensions for search:

- **pgvector** for semantic (vector) search
- **pg_textsearch** for BM25 keyword search
- **ltree** for hierarchical tree paths
- **JSONB + GIN** for metadata filtering
- **tstzrange** for temporal queries
- **Row-Level Security** for access control

## Documentation

- [Getting Started](docs/getting-started.md) -- install, login, first memory
- [Core Concepts](docs/concepts.md) -- memories, tree paths, metadata, search modes
- [Access Control](docs/access-control.md) -- users, roles, grants, ownership
- [Memory Packs](docs/memory-packs.md) -- pre-built knowledge collections
- [MCP Integration](docs/mcp-integration.md) -- connecting AI agents

### Reference

- [CLI Commands](docs/cli/) -- full command reference
- [MCP Tools](docs/mcp/) -- full MCP tool reference

## License

[Apache 2.0](LICENSE)
