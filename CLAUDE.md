# Memory Engine

Permanent memory for AI agents. Store, search, and organize knowledge across conversations.

## Documentation

All project documentation lives in `docs/`:

- [Getting Started](docs/getting-started.md) -- install, login, first memory
- [Core Concepts](docs/concepts.md) -- memories, tree paths, metadata, search modes
- [File Formats](docs/formats.md) -- JSON, YAML, Markdown, NDJSON import/export schemas
- [Access Control](docs/access-control.md) -- users, roles, grants, ownership
- [Memory Packs](docs/memory-packs.md) -- pre-built knowledge collections
- [MCP Integration](docs/mcp-integration.md) -- connecting AI agents
- [CLI Reference](docs/cli/) -- full command reference
- [MCP Tool Reference](docs/mcp/) -- full MCP tool reference

Read the relevant docs before starting work on a subsystem.

## Quick Reference

- **Tech stack**: Bun, TypeScript, PostgreSQL 18 (pgvector, pg_textsearch, ltree, JSONB)
- **Core schema**: Single table `memory` per engine schema (`me_<slug>`) -- content, meta (JSONB), tree (ltree), temporal (tstzrange), embedding (halfvec(1536))
- **Search**: Hybrid BM25 + semantic via Reciprocal Rank Fusion
- **API**: JSON-RPC 2.0 over HTTP -- engine RPC (`/api/v1/engine/rpc`) and accounts RPC (`/api/v1/accounts/rpc`), plus REST auth endpoints (OAuth device flow)
- **Auth**: Tree-grant RBAC with PostgreSQL RLS; OAuth (GitHub, Google) for hosted accounts
- **Embedding**: Vercel AI SDK; OpenAI `text-embedding-3-small` (1536-dim) in production; Ollama supported for local dev
- **CLI**: `me` binary (login, logout, whoami, org, engine, invitation, memory, mcp, user, grant, role, owner, apikey, pack)

## Project Structure

```
packages/
  cli/          # CLI and MCP server (the `me` binary)
  client/       # TypeScript client for the engine API
  engine/       # Core engine (database operations, search, embedding)
  protocol/     # Shared types and Zod schemas (JSON-RPC methods)
  hosted/       # Hosted/multi-tenant provisioning
  docs-site/    # Next.js static site that renders `docs/` for docs.memory.build
packs/            # Memory packs (pre-built knowledge collections)
docs/
  cli/          # CLI command reference (one file per command group)
  mcp/          # MCP tool reference (one file per tool)
```

> **Note**: `packages/hosted` is the target package name; the current implementation is split across `packages/accounts` (org/member/engine management, OAuth), `packages/server` (HTTP server, routing, RPC handlers), `packages/embedding` (vector embedding providers), and `packages/worker` (background embedding queue processor).

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

### Database integration tests

`*.integration.test.ts` files run against a real PostgreSQL 18 with the
required extensions (citext, ltree, pgvector, pg_textsearch), provisioned with
ghost. Point `TEST_DATABASE_URL` at a ghost database and run:

```bash
TEST_DATABASE_URL="$(ghost connect testing_me)" ./bun run test:db
```

`testing_me` is the dedicated ghost database for these tests.

To run a single integration file directly, pass `--timeout 30000` (as `test:db`
does). bun's default 5s timeout isn't enough over a remote ghost connection —
the migrating `beforeAll` provisions a full core/space and overruns it, which
surfaces as a misleading "beforeEach/afterEach hook timed out":

```bash
TEST_DATABASE_URL="$(ghost connect testing_me)" \
  ./bun test --timeout 30000 packages/core/migrate/migrate.integration.test.ts
```

Isolation is **schema-level** (ghost forbids `create database`): each test
provisions its own schema — `core_test_<rand>` for core, `me_<slug>` for
spaces — so the suites are fully concurrent and parallel-safe across files.
The core migrations are templated so production uses `core` while tests target
throwaway schemas and never touch a real control plane.

## Style Guides

**TypeScript**: Biome for linting and formatting. Config in `biome.json`.

**SQL**: Lowercase keywords, leading-comma table definitions, inline comments after columns, native `uuid` with `uuidv7()`.

```sql
create table me.memory
( id                   uuid          not null default uuidv7()  -- PK, UUIDv7
, content              text          not null                   -- memory text
, meta                 jsonb         not null default '{}'      -- arbitrary metadata
, tree                 ltree         not null default ''        -- hierarchical path
, temporal             tstzrange                                -- optional time range
, embedding            halfvec(1536)                            -- semantic vector
);
```

## Key Design Decisions

- **Single table**: All memory types live in `me.memory`. Complexity comes from conventions in `meta` and `tree`, not schema proliferation.
- **Database-native**: Uses PostgreSQL extensions (ltree, pgvector, JSONB GIN, tstzrange, BM25) instead of application-layer abstractions.
- **Flexibility over prescription**: `meta` accepts any JSON, `tree` paths are user-defined, `temporal` is optional. No enforced conventions.
- **MCP compatibility**: All tool parameters are required (nullable for optional). Uses `z.record(z.string(), z.any())` for meta instead of `z.record(z.unknown())` (which crashes the MCP SDK).

## Database driver migration: Bun.SQL → postgres.js (in progress)

**Why:** `Bun.SQL` (`new Bun.SQL(...)`) does not return a pooled connection after a
query or `begin()` callback errors — after `max` such errors the pool drains and the
next acquire hangs forever (Bun bug [oven-sh/bun#22395](https://github.com/oven-sh/bun/issues/22395),
reproduced on 1.3.13 and 1.3.14). Any *expected* constraint violation on a long-lived
pool — e.g. the engine/accounts pools in `packages/server/index.ts` — can wedge the
server until restart. Both `postgres` (postgres.js) and `pg` fix it on the Bun runtime;
we use **postgres.js** because `Bun.SQL`'s API was modeled on it, so it's a near-drop-in.

**Done & verified (local + ghost):** the migrate path — `packages/core/migrate/*`,
`packages/space/migrate/*` (incl. `test-utils.ts`), and `scripts/migrate-db.ts`.

**Remaining**, package by package, each behind its own integration tests:
`packages/engine` (`db.ts`, `ops/*`, `migrate/*`), `packages/accounts` (`db.ts`, `ops/*`,
`migrate/*`), `packages/server` (`index.ts` pools, `context.ts`, handlers), `packages/worker`.
Spot-check `halfvec`/`ltree`/`tstzrange` round-trips and the `sql(identifier)` interpolations.

**Per-file recipe:**
- Add `"postgres": "^3.4.9"` to the package's `package.json`.
- `import { SQL } from "bun"` → `import postgres from "postgres"` (value) and/or
  `import type { Sql as SQL } from "postgres"` (type). Type a param that receives a
  transaction (`sql.begin`'s `tx`) as `ISql<{}>` — both `Sql` and `TransactionSql` extend
  `ISql`; keep `Sql<{}>` only for code that calls `.begin`.
- `new Bun.SQL(url, { max, idleTimeout, maxLifetime, connectionTimeout })` →
  `postgres(url, { max, idle_timeout, max_lifetime, connect_timeout, onnotice: () => {} })`
  (snake_case; `onnotice` silences routine migration NOTICEs).
- `sql.close()` → `sql.end()`.
- `error instanceof SQL.PostgresError` → duck-type (`(error as { position?: unknown }).position`).
- Rows: postgres.js returns a typed `Row` (index signature), but `noUncheckedIndexedAccess`
  makes `rows[0]` possibly-`undefined` → `const [row] = ...; row?.col`, and drop
  `(r: { col: T })` annotations on `.map` callbacks (`r` is `Row`).

**Test gotcha:** `expect(sql\`…\`).rejects` **hangs** in bun:test — it doesn't drive
postgres.js's lazy `PendingQuery`. Assert query failures with try/catch (see `expectReject`
in `migrate/test-utils.ts`). `expect(migrateX(…)).rejects` is fine (real async-fn Promise).
