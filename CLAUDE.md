# Memory Engine

Permanent memory for AI agents. Store, search, and organize knowledge across conversations.

## Documentation

All project documentation lives in `docs/`:

- [Getting Started](docs/getting-started.md) -- install, login, first memory
- [Core Concepts](docs/concepts.md) -- memories, tree paths, metadata, search modes
- [Access Control](docs/access-control.md) -- users, roles, grants, ownership
- [Memory Packs](docs/memory-packs.md) -- pre-built knowledge collections
- [MCP Integration](docs/mcp-integration.md) -- connecting AI agents
- [CLI Reference](docs/cli/) -- full command reference
- [MCP Tool Reference](docs/mcp/) -- full MCP tool reference

Read the relevant docs before starting work on a subsystem.

## Quick Reference

- **Tech stack**: Bun, TypeScript, PostgreSQL 18 (pgvector, pg_textsearch, ltree, JSONB)
- **Core schema**: Single table `me.memory` -- content, meta (JSONB), tree (ltree), temporal (tstzrange), embedding (halfvec)
- **Search**: Hybrid BM25 + semantic via Reciprocal Rank Fusion
- **API**: JSON-RPC 2.0 over HTTP, single `/rpc` endpoint
- **Auth**: Tree-grant RBAC with PostgreSQL RLS
- **Embedding**: Vercel AI SDK; supports OpenAI, Ollama
- **CLI**: `me` binary (login, engine, memory, mcp, user, grant, role, owner, apikey, pack)

## Project Structure

```
packages/
  cli/          # CLI and MCP server (the `me` binary)
  client/       # TypeScript client for the engine API
  engine/       # Core engine (database operations, search, embedding)
  protocol/     # Shared types and Zod schemas (JSON-RPC methods)
  hosted/       # Hosted/multi-tenant provisioning
docs/
  cli/          # CLI command reference (one file per command group)
  mcp/          # MCP tool reference (one file per tool)
```

## Build, Lint, and Test

Always use the `./bun` wrapper script (auto-installs the pinned Bun version):

```bash
# Install dependencies
./bun install

# Type checking
./bun run typecheck

# Linting and formatting (auto-fix)
./bun run lint --write

# Run unit tests
./bun test

# Run a single test file
./bun test packages/cli/mcp/install.test.ts

# Shorthand for all checks (typecheck + lint + test)
./bun run check
```

**Important**: After making code changes, always run `./bun run check`.

## Style Guides

**TypeScript**: Biome for linting and formatting. Config in `biome.json`.

**SQL**: Lowercase keywords, leading-comma table definitions, inline comments after columns, native `uuid` with `uuidv7()`.

```sql
create table me.memory (
  id                   uuid          not null default uuidv7()  -- PK, UUIDv7
, content              text          not null                   -- memory text
, meta                 jsonb         not null default '{}'      -- arbitrary metadata
, tree                 ltree         not null default ''        -- hierarchical path
, temporal             tstzrange                                -- optional time range
, embedding            halfvec(768)                             -- semantic vector
);
```

## Key Design Decisions

- **Single table**: All memory types live in `me.memory`. Complexity comes from conventions in `meta` and `tree`, not schema proliferation.
- **Database-native**: Uses PostgreSQL extensions (ltree, pgvector, JSONB GIN, tstzrange, BM25) instead of application-layer abstractions.
- **Flexibility over prescription**: `meta` accepts any JSON, `tree` paths are user-defined, `temporal` is optional. No enforced conventions.
- **MCP compatibility**: All tool parameters are required (nullable for optional). Uses `z.record(z.string(), z.any())` for meta instead of `z.record(z.unknown())` (which crashes the MCP SDK).

## Other Repos

These are stand-alone repos in `repos/`, NOT git submodules. Change directory into them before committing:

- `repos/me` -- prior version of Memory Engine (reference for carrying forward decisions)
- `repos/memorypacks` -- public repo containing memory packs
- `repos/integrations` -- public repo containing integrations for syncing outside sources
