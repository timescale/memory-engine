# Memory Engine

Permanent memory for AI agents. Store, search, and organize knowledge across conversations.

## Documentation

All project documentation lives in `docs/`:

- [Getting Started](docs/getting-started.md) -- install, login, first memory
- [Core Concepts](docs/concepts.md) -- memories, tree paths, metadata, search modes
- [File Formats](docs/formats.md) -- JSON, YAML, Markdown, NDJSON import/export schemas
- [Access Control](docs/access-control.md) -- principals, groups, tree-access grants
- [Memory Packs](docs/memory-packs.md) -- pre-built knowledge collections
- [MCP Integration](docs/mcp-integration.md) -- connecting AI agents
- [CLI Reference](docs/cli/) -- full command reference
- [MCP Tool Reference](docs/mcp/) -- full MCP tool reference

Read the relevant docs before starting work on a subsystem.

> **Note**: the authoritative summary of the current model (principals / spaces /
> the auth+core+space schemas) is in this file. Some `docs/` pages still describe
> the retired engine/org/role model and may lag — trust this file when they
> disagree, and fix the docs as you touch them.

## Quick Reference

- **Tech stack**: Bun, TypeScript, PostgreSQL 18 (pgvector/halfvec, pg_textsearch BM25, ltree, citext, JSONB), **postgres.js** driver. One database, one pool.
- **Schemas** (three, one database): `auth` (better-auth-shaped: `users`, `sessions`, `accounts`, `device_authorization`), `core` (control plane: `principal`, `space`, `principal_space`, `group_member`, `tree_access`, `api_key`), and per-space `me_<slug>` (data plane: the single `memory` table). `auth.users.id == core.principal.id` for user principals.
- **Memory table** (per space): `content`, `meta` (JSONB), `tree` (ltree), `temporal` (tstzrange), `embedding` (halfvec(1536)).
- **Search**: hybrid BM25 + semantic via Reciprocal Rank Fusion, computed in SQL functions.
- **Access**: no RLS. `core.build_tree_access(principalId, spaceId)` produces a `_tree_access` jsonb (rows of `tree_path` + `access`) passed into the space SQL functions (`search_memory`, `get_memory`, …). Three additive levels: **1 = read, 2 = write, 3 = owner**; `owner@root` (the empty ltree path) owns the whole space, and an owner grant at any path delegates access-management within that subtree. Two axes: **structural** authority (`principal_space.admin` — roster mutations, groups, invitations) vs **data** authority (owner@path); an admin may also grant data and can self-grant `owner@root`. The auth gate is a non-empty `build_tree_access` (every member holds ≥1 grant).
- **Tree conventions**: two reserved roots — per-member `home.<member_id>` (`~` is input sugar for it; a joining **user** is granted `owner@home`) and the shared `share`. A space **creator** gets `admin` + `owner@home` + `owner@share`, **not** `owner@root` — so it sees `share` and its own `~` but not other members' homes (as an admin it can self-grant `owner@root`). A bare `memory.create` (no `tree`) defaults to `share` (`SHARE_NAMESPACE`).
- **API**: JSON-RPC 2.0 over HTTP, two endpoints:
  - `/api/v1/memory/rpc` — session **or** api-key bearer + required `X-Me-Space: <slug>` header. Memory data plane (`memory.*`) + space management (`principal.*`, `group.*`, `grant.*`, `invite.*`).
  - `/api/v1/user/rpc` — session only (an api key never authenticates here; agents can't manage agents). `whoami`, `agent.*`, `apiKey.*`, `space.*`.
  - Plus REST OAuth device-flow endpoints under `/api/v1/auth/*`.
- **Auth**: humans use a **session token** (OAuth device flow, GitHub/Google); agents use an **api key** (`me.<lookupId>.<secret>`). Api keys are **global** per-principal credentials, not space-bound: the same key works in any space the agent has been admitted to (the space comes from `X-Me-Space`, gated by `build_tree_access`). Session + api-key secrets are sha256 (compared by equality in SQL), not argon2.
- **Embedding**: Vercel AI SDK; OpenAI `text-embedding-3-small` (1536-dim) in production; Ollama supported for local dev.
- **CLI**: `me` binary — `login`, `logout`, `whoami`, `space`, `group`, `access`, `agent`, `apikey`, `memory` (+ top-level aliases like `me search`, `me create`), `mcp`, `claude`/`codex`/`gemini`/`opencode`, `serve`, `pack`.

## Principals, members, spaces (terminology)

- **Principal** = the union **user | agent | group** (`principal.kind` = `'u'` | `'a'` | `'g'`). The space roster (`principal_space`) holds principals. `principal.member_id` is a generated column equal to `id` for users/agents (NOT groups).
- **Member** = the **user/agent** sense only — group members and api-key holders. So params split as `principalId` (roster / grants, any kind) vs `memberId` (group membership, api keys; u|a only). The space-roster surface is principal-centric (`principal.*` methods, `SpacePrincipal` type), reserving "member" for u|a.
- **Space**: identified by an immutable 12-char `slug` (which is the `me_<slug>` schema name and the `X-Me-Space` value) and a renamable `name`. `me space rename` changes only the name. No org / engine / shard concepts.
- **Admin**: `principal_space.admin` is *structural* authority — roster mutations (`principal.add`/`remove`), groups, and invitations (`invite.*`) — distinct from data ownership (owner@path via `tree_access`). Enumerating the whole roster (`principal.list`) is admin-only; **any member** may `principal.resolve`/`lookup` (a targeted name↔id lookup, not enumeration). Admin transfers **transitively** through a group whose own `principal_space.admin` is true; agents are never admins. A space must always keep ≥1 *effective* admin (a **user** who is a direct admin or a member of an admin group — an empty admin group doesn't count) — the `enforce_last_admin` trigger on `principal_space` + `group_member` rejects any remove/demote/group-member-removal that would drop the last one (SQLSTATE `ME001` → `LAST_ADMIN`), but exempts whole-space deletion.
- **Transitive membership** (Model 2): a group member gains the group's space membership, its space-admin (if the group is admin), and its tree-access grants.

## Project Structure

```
packages/
  auth/         # auth-schema store: users, sessions, oauth accounts, device flow
  cli/          # CLI + MCP server (the `me` binary)
  claude-plugin/# Claude Code plugin (capture hooks, slash commands)
  client/       # TS client: createMemoryClient + createUserClient (+ auth device flow)
  database/     # schema migrations (auth, core, space) + shared migrate kit
  docs-site/    # Next.js static site that renders `docs/` for docs.memory.build
  embedding/    # vector embedding providers (OpenAI, Ollama)
  engine/       # runtime stores over the SQL functions: core (control plane) + space (data plane)
  protocol/     # shared Zod schemas + types: memory + space + user contracts; auth/fields/headers/jsonrpc/errors/version
  server/       # HTTP server, routing, RPC handlers, OAuth, first-login provisioning
  web/          # React UI served by `me serve` (talks to the same-origin /rpc proxy)
  worker/       # background embedding queue processor
packs/            # Memory packs (pre-built knowledge collections)
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

> `packages/web` and `packages/docs-site` are excluded from the root typecheck
> (they have their own); `./bun run check` does not cover them.

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
the migrating `beforeAll` provisions a full auth/core/space and overruns it,
which surfaces as a misleading "beforeEach/afterEach hook timed out":

```bash
TEST_DATABASE_URL="$(ghost connect testing_me)" \
  ./bun test --timeout 30000 packages/database/core/migrate/migrate.integration.test.ts
```

Isolation is **schema-level** (ghost forbids `create database`): each test
provisions its own throwaway schema(s) — `core_test_<rand>` for core,
`auth_test_<rand>` for auth, `metest_<slug>` for spaces — so the suites are
fully concurrent and parallel-safe across files. All migrations are templated,
so production uses `core` / `auth` / `me_<slug>` while tests target throwaway
schemas and never touch real data. Test spaces deliberately use the `metest_`
prefix (not the production `me_`) so leftovers are distinguishable from real
spaces by name alone.

`test:db` first runs `test:db:clean` (`scripts/clean-test-schemas.ts`) to
reclaim orphaned `core_test_*` / `auth_test_*` / `metest_*` schemas left by
hard-interrupted runs. It is age-gated (only drops schemas older than 60 min, so
a concurrent `test:db` sharing the database is safe) and a no-op against a
production database — no pattern can match a real schema. Use `test:db:clean:all`
for a deliberate full reset when nothing else is using the database.

## Style Guides

**TypeScript**: Biome for linting and formatting. Config in `biome.json`.

**SQL**: Lowercase keywords, leading-comma table definitions, inline comments after columns, native `uuid` with `uuidv7()`. Logic lives in SQL functions; the TS stores call functions rather than querying tables directly.

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

- **One DB, one pool**: `auth` + `core` + every `me_<slug>` live in one Postgres database behind one postgres.js pool (plus a dedicated worker pool). Sharding / pgdog distribution is deferred; the per-slug schema model keeps a future re-split cheap.
- **Single memory table per space**: all memory lives in `me_<slug>.memory`. Complexity comes from conventions in `meta` and `tree`, not schema proliferation.
- **Database-native**: PostgreSQL extensions (ltree, pgvector/halfvec, JSONB GIN, tstzrange, BM25) instead of application-layer abstractions.
- **Access via `tree_access`, not RLS**: RLS was unperformant. `build_tree_access` produces a `_tree_access` jsonb passed into the space functions; there is no `me.user_id` GUC. Three levels (read/write/owner); an owner grant delegates access-management within its subtree (owner@root = the whole space).
- **Two endpoints, two auth modes**: memory RPC (session or api key + `X-Me-Space`) vs user RPC (session only). `extractBearerToken` is the one shared auth helper.
- **Principal vs member** terminology (see above): principal = u|a|g; member/`memberId` = u|a.
- **CLI credentials**: split across `~/.config/me/` — **`config.yaml`** (non-secret: default server + per-server **active space** / the X-Me-Space) and **`credentials.yaml`** (0600, secret session-token *fallback* only). The **session token** lives in the OS keychain when available (macOS `security`, Linux `secret-tool` via libsecret; `ME_NO_KEYCHAIN=1` forces off), else in `credentials.yaml` (empty/absent on keychain hosts); a pre-split `credentials.yaml` is migrated on first read. `me logout` clears the session secret but keeps the non-secret config (so re-login resumes). **Api keys are never persisted** — an agent key only ever comes from `ME_API_KEY` (humans authenticate with sessions; `apiKey.create` prints the key once for the operator to place where the agent runs). Env: `ME_SERVER` / `ME_API_KEY` / `ME_SPACE` / `ME_SESSION_TOKEN` / `ME_NO_KEYCHAIN`.
- **Header constants** (`CLIENT_VERSION_HEADER`, `SPACE_HEADER`) live in `@memory.build/protocol/headers`.
- **MCP compatibility**: all tool parameters are required (nullable for optional). Uses `z.record(z.string(), z.any())` for meta instead of `z.record(z.unknown())` (which crashes the MCP SDK).

## Database driver: postgres.js

The runtime is fully on **postgres.js**. We moved off `Bun.SQL` because it does
not return a pooled connection after a query or `begin()` callback errors —
after `max` such errors the pool drains and the next acquire hangs forever (Bun
bug [oven-sh/bun#22395](https://github.com/oven-sh/bun/issues/22395)). The single
application pool + the worker pool + all stores and migrations use postgres.js.
The only remaining `Bun.SQL` use is `scripts/setup.ts`, a dev-only
create-database helper (short-lived, no long pool — the bug doesn't bite).

Gotchas when writing DB code / tests:

- Pass jsonb to SQL functions via `sql.json(v)` — a raw `JSON.stringify` double-encodes and a raw array sends as a PG array.
- `noUncheckedIndexedAccess` makes `rows[0]` possibly-`undefined` → `const [row] = ...; row?.col`; don't annotate `.map((r: {col}) => …)` (the row is a typed `Row`).
- `expect(sql\`…\`).rejects` **hangs** in bun:test — it doesn't drive postgres.js's lazy `PendingQuery`. Assert query failures with try/catch (see `expectReject` in `packages/database/migrate/test-utils.ts`). `expect(migrateX(…)).rejects` is fine (a real async-fn Promise).
- `to_bm25query(text, index_name text)` — the index name is `text`, not `regclass`. citext function params: compare with `_x::citext` or it silently degrades to case-sensitive `text = text`.
