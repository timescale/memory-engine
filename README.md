# Memory Engine

Permanent memory for AI agents. Store, search, and organize knowledge across conversations.

Memory Engine gives AI coding agents a persistent memory layer they can read from and write to via MCP. Memories are organized with tree paths, tagged with metadata, and searchable by meaning (semantic), keywords (BM25), or both (hybrid via Reciprocal Rank Fusion).

## Install

```bash
curl -fsSL https://install.memory.build | sh
```

Alternative install methods:

### Homebrew

```bash
brew install timescale/tap/me
```

### NPM

```bash
npm i -g @memory.build/cli
```

## Quick start

```bash
# Authenticate
me login

# Install the integration for your coding agent (once, user scope)
me claude install     # or: me opencode install / me codex install

# Turn on capture for a project and choose where its memories live
cd ~/code/your-project
me init . \
  --capture-server https://api.memory.build \
  --capture-space <space> \
  --capture-tree /share/projects/your-project \
  --capture-harness claude
```

`me claude install` installs the Claude Code plugin (hooks + slash commands +
MCP), dormant — it never logs in or turns anything on. `me init` is
machine-local: it enables session capture and points it at a server, space, and
tree (captures default **privately** to `~/projects/<repo>`). Backfill past
sessions and git history with `me import claude` / `me import git`, and inspect
what applies to a directory with `me doctor`.

## Usage

```bash
# Store a memory
me memory create "Auth uses bcrypt with cost 12" --tree share.design.auth

# Search by meaning + keywords
me memory search "how does authentication work"

# Import memories, agent sessions, and git history
me import memories notes.md      # md / yaml / json / ndjson records
me import claude                 # all Claude Code sessions on this machine
me import git                    # a repo's commit history

# Connect other AI tools (Claude Code uses `me claude install`)
me opencode install
me codex install
```

## How it works

Memory Engine runs as an MCP server that AI agents connect to over stdio. Each agent gets 10 tools for creating, searching, and managing memories. All data lives in PostgreSQL, using native extensions for search:

- **pgvector** for semantic (vector) search
- **pg_textsearch** for BM25 keyword search
- **ltree** for hierarchical tree paths
- **JSONB + GIN** for containment and PostgreSQL JSONPath metadata predicates
- **tstzrange** for temporal queries
- **Tree-scoped access grants** evaluated in the search SQL (no RLS)

## Self-hosting

Want to run your own Memory Engine backend? See **[Self-Hosting](SELF_HOST.md)**
— a Docker Compose stack (server + PostgreSQL), built from a tagged release,
plus building the `me` CLI from source to connect to it.

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
