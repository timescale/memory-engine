# Memory Engine

Memory Engine — permanent memory for AI agents. Store, search, and organize knowledge across conversations.

**Docker Sandbox:** Detect with `IS_SANDBOX=1` env var. You have your own isolated Docker daemon — use it freely without asking.

Available tools: `bun`, `postgresql-client` (psql), `sqlite3`, `duckdb`, `lua5.4`, `ripgrep` (rg), `jq`, `yq`, `gh`, `tree`, `vim`, `curl`, `wget`.

## Other Repos

These are NOT git submodules; they are stand-alone repos. Change directory into them before committing changes to them.

@repos/me is the private git repo used for the prior version of Memory Engine; much of this will be reused

@repos/memorypacks is the public git repo containing memory packs

@repos/integrations is the public git repo containing a few integrations for syncing outside sources to memories

## Using Memory

This project uses memory engine itself. Search memory proactively:

- **Before starting work**: search for relevant design decisions, prior art, and context
- **When making decisions**: check if the topic has been researched or decided before
- **After completing work**: store significant design decisions, research findings, and architectural choices so they survive across sessions

Don't ask permission to search — just search. When storing memories, use the `me.design.*` tree for implementation details and `me.strategy.*` for product/business decisions.

## Memory Map

All project knowledge lives in the `me` MCP server. This file describes what's there so you know what to search for. Don't memorize IDs — use search.

### How to Search

```
# By tree path (browse a section)
me_memory_search({tree: "me.strategy.*"})

# Semantic (find by meaning)
me_memory_search({semantic: "how does authentication work"})

# Full-text (find by keyword)
me_memory_search({fulltext: "RLS pgvector ltree"})

# Hybrid (meaning + keywords together)
me_memory_search({semantic: "cold start problem", fulltext: "bootstrapping agents"})

# By metadata
me_memory_search({meta: {type: "reference", topic: "architecture"}})

# Browse the full tree structure
me_memory_tree({levels: 3})
```

### Strategy (`me.strategy.*`)

Why we're building this and for whom. Covers the problem space, competitive landscape, design philosophy, and go-to-market.

Key topics: context engineering as the core activity (not just "memory"), the three unsolved memory problems, eight design principles (database-native, flexibility over prescription, system-scheduled over agent-initiated, etc.), memory agents as our core differentiator, competitive analysis of Mem0/Zep/Letta/Cognee/others, product positioning, pricing research, naming rationale ("memory engine" / `me`).

```
me_memory_search({tree: "me.strategy.*"})
me_memory_search({semantic: "why build memory engine, what problem does it solve"})
me_memory_search({semantic: "how do we compare to competitors"})
me_memory_search({fulltext: "Mem0 Zep Letta Cognee"})
```

### Design (`me.design.*`)

How the system works — subsystem designs, research spikes, and architectural decisions.

**Core subsystems**: Auth & RBAC (tree-grant access control with PostgreSQL RLS, principals, ownership, grants, roles), embedding worker (background daemon, batch processing, retry logic), hybrid search (BM25 + semantic via Reciprocal Rank Fusion), memory packs (YAML-based pre-built knowledge packages), skill memories (progressive disclosure teaching agents to use the system), CLI import.

**Research & decisions**: Better Auth for hosted authentication (adopted), app-level tenant routing over pgDog (decided), Bun.sql over pg for core operations (decided), self-hosted distribution via Docker Compose + Ollama (designed).

```
me_memory_search({tree: "me.design.*"})
me_memory_search({semantic: "how does search work internally"})
me_memory_search({semantic: "how are embeddings generated"})
me_memory_search({fulltext: "RLS row level security"})
me_memory_search({semantic: "what authentication approach for hosted"})
```

### Hosted / Multi-Tenant (`me.design.hosted.*`)

Architecture for the hosted product: each tenant gets an isolated Ghost DB + Fly app. Fly Replay gateway routes requests via opaque URL slugs. Provisioning CLI (`packages/hosted`) creates/tears down tenants.

```
me_memory_search({tree: "me.design.hosted.*"})
me_memory_search({semantic: "how does multi-tenant routing work"})
me_memory_search({fulltext: "Fly Replay Ghost"})
```

### Embedding Deep Dive (`me.design.embedding.*`)

12 memories covering embedding providers, Docker Model Runner (DMR), Ollama, performance benchmarks, gotchas, API integration, GGUF patching, and publishing patched models.

```
me_memory_search({tree: "me.design.embedding.*"})
me_memory_search({semantic: "embedding performance comparison"})
me_memory_search({fulltext: "DMR Ollama nomic"})
```

### Previous Architecture (`me.agents.*`)

Detailed reference docs from the prior implementation. Useful for understanding what existed and carrying forward decisions. Covers: codebase guide (architecture diagram, schema, CLI commands), RPC method system & Zod schemas, database migrations & test helpers, search & embedding pipeline, Docker/Postgres setup (PG18, pgvector, pg_textsearch), Biome linter/formatter config.

```
me_memory_search({tree: "me.agents.*"})
me_memory_search({semantic: "how did the RPC system work"})
me_memory_search({fulltext: "migration advisory lock"})
```

### Git History & GitHub (`me.git_history.*`, `me.github.*`)

449 git commit memories and 227 GitHub memories (PRs, issues, CI runs, releases) from the prior codebase. Useful for understanding why past decisions were made.

```
me_memory_search({tree: "me.github.issues.*"})
me_memory_search({tree: "me.github.prs.*", semantic: "search performance"})
me_memory_search({tree: "me.git_history.*", fulltext: "embedding worker"})
```

## Style Guides

**SQL**: Lowercase keywords, leading-comma table definitions, inline comments after columns, native `uuid` with `uuidv7()`. Full guide in memory:

```
me_memory_search({tree: "me.design.sql_style_guide"})
```

## Quick Reference

- **Tech stack**: Bun, TypeScript, PostgreSQL 18 (pgvector, pg_textsearch, ltree, JSONB)
- **Core schema**: Single table `me.memory` — content, meta (JSONB), tree (ltree), temporal (tstzrange), embedding (halfvec)
- **Search**: Hybrid BM25 + semantic via Reciprocal Rank Fusion
- **API**: JSON-RPC 2.0 over HTTP, single `/rpc` endpoint
- **Auth**: Tree-grant RBAC with PostgreSQL RLS
- **Embedding**: Vercel AI SDK; supports OpenAI, Ollama, DMR, local WASM
- **CLI**: `me` command (install, server, mcp, login, memory, pack, service)

# currentDate
Today's date is 2026-03-13.
