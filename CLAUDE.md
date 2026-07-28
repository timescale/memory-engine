# Memory Engine

Permanent memory for AI agents. Store, search, and organize knowledge across conversations.

## Documentation

All project documentation lives in `docs/`:

- [Getting Started](docs/getting-started.md) -- install, login, first memory
- [Joining a Space](docs/joining-a-space.md) -- onboarding for invited teammates + shared-space conventions
- [Core Concepts](docs/concepts.md) -- memories, tree paths, metadata, search modes
- [Projects](docs/projects.md) -- repository memory trees and project grants
- [Project Config](docs/project-config.md) -- `.me/config.yaml`: per-project server/space/tree pinning
- [File Formats](docs/formats.md) -- JSON, YAML, Markdown, NDJSON import/export schemas
- [Access Control](docs/access-control.md) -- principals, groups, tree-access grants
- [Memory Packs](docs/memory-packs.md) -- pre-built knowledge collections
- [MCP Integration](docs/mcp-integration.md) -- connecting AI agents
- [TypeScript Client](docs/typescript-client.md) -- programmatic access from TS/JS
- [Troubleshooting](docs/troubleshooting.md) -- common issues and error codes
- [CLI Reference](docs/cli/) -- full command reference
- [MCP Tool Reference](docs/mcp/) -- full MCP tool reference

Read the relevant docs before starting work on a subsystem.

> **Audience — `docs/` is for _users_ of Memory Engine, not its developers.**
> Everything under `docs/` is published to https://docs.memory.build/ (GitHub
> Pages), so write it for people _using_ Memory Engine (developer-leaning, but not
> restricted to developers) — not for people _building_ it. Keep user-relevant
> terms (semantic/fulltext/hybrid search, tree paths, grant levels), but keep
> ME-internal detail out: no source paths (`packages/…`), internal function or DB
> schema names (e.g. `me_<slug>`, SQL/RPC function names), internal design docs
> (`AUTH_DESIGN.md`, `HARNESS_DESIGN.md`), Linear links, CI/test mechanics, or
> roadmap/unbuilt features. Contributor/build/design notes belong in this file and
> the other root `*_DESIGN.md`/`DEVELOPMENT.md` docs instead. New CLI commands and
> MCP tools need a matching page (enforced by `packages/cli/docs-cli-links.test.ts`
> and `packages/cli/mcp/docs-links.test.ts`); new `docs/` pages must be added to
> the sidebar in `packages/docs-site/lib/nav.ts` (enforced by
> `packages/docs-site/lib/nav.test.ts`).

> **Note**: the authoritative summary of the current model (principals / spaces /
> the auth+core+space schemas) is in this file. Some `docs/` pages still describe
> the retired engine/org/role model and may lag — trust this file when they
> disagree, and fix the docs as you touch them.

## Quick Reference

- **Tech stack**: Bun, TypeScript, PostgreSQL 18 (pgvector/halfvec, pg_textsearch BM25, ltree, citext, JSONB), **postgres.js** driver. One database, one pool.
- **Schemas** (three, one database): `auth` (better-auth + its oauth-provider plugin: `users`, `sessions`, `accounts`, `verifications`, `jwks`, `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`), `core` (control plane: `principal`, `space`, `principal_space`, `group_member`, `tree_access`, `api_key`), and per-space `me_<slug>` (data plane: the single `memory` table). `auth.users.id == core.principal.id` for user principals.
- **Memory table** (per space): `content`, `name` (text — optional filename-like leaf slug, unique within `(tree, name)` via a partial unique index where name is not null), `meta` (JSONB), `tree` (ltree), `temporal` (tstzrange), `embedding` (halfvec(1536)). Addressed by immutable `id` (`memory.get`/`delete`) or by `folder/name` path (`memory.getByPath`/`deleteByPath`, split at the final `/`); `deleteTree` removes a subtree. Wire/display paths are canonical leading-slash (`/share/auth`, `~/notes`, root `/`); the leading slash is optional on input. ltree storage and the access-grant shorthand below (`owner@home.<id>`) stay dotted because that is the literal ltree representation.
- **Search**: hybrid BM25 + semantic via Reciprocal Rank Fusion, computed in SQL functions.
- **Access**: no RLS. `core.build_tree_access(principalId, spaceId)` produces a `_tree_access` jsonb (rows of `tree_path` + `access`) passed into the space SQL functions (`search_memory`, `get_memory`, …). Three additive levels: **1 = read, 2 = write, 3 = owner**; `owner@root` (the empty ltree path) owns the whole space, and an owner grant at any path delegates access-management within that subtree. Two axes: **structural** authority (`principal_space.admin` — roster mutations, groups, invitations) vs **data** authority (owner@path); an admin may also grant data and can self-grant `owner@root`. Granting requires owner@path (or space admin). Service accounts have no owner clamp; revocation of a service-account grant is also allowed for direct user members of the service account's bound admin group. Endpoint admission is direct `principal_space` membership, so a member may authenticate with zero tree grants; data access is still filtered by `build_tree_access`.
- **Tree conventions**: two reserved roots — per-member `home.<member_id>` (`~` is input sugar for it; a joining **user** is granted `owner@home.<user_id>`) and the shared `share`. Service accounts have no home grant and no defined `~` home; they get zero tree access until explicitly granted access directly or through a group. A space **creator** gets `admin` + `owner@home` + `owner@share`, **not** `owner@root` — so it sees `share` and its own `~` but not other members' homes (as an admin it can self-grant `owner@root`). **Custom spaces** vary these provisioning defaults via `me space create` flags, resolved in `addSpaceCreator`: `--no-home-grants` sets the space column `space.auto_grant_home = false` (read by `add_principal_to_space`, so **every** join path stops seeding `owner@~` for users) and flips the creator to **god mode** (`admin` + `owner@/`); the default group is controlled by whether `provision_default_group` is called (`--no-default-group`), its name (`--default-group <name>`), and whether it's seeded with grants (`--no-default-group-grants`) — the chosen group is flagged `principal.is_default_group` (one per space, partial-unique; rename/delete-robust; surfaced on the space read as `defaultGroup` and used as the `me space invite` default). There is no `auto_grant_team` column — group grants are just `tree_access` rows. `memory.create`/`batchCreate` **require** an explicit `tree` (callers choose `share` vs `~` deliberately); only the file importers (`me import memories`, the `me_memory_import` MCP tool) default a tree-less record to `share` (`SHARE_NAMESPACE`, canonically defined in `@memory.build/protocol` and re-exported by `@memory.build/database`).
- **API**: JSON-RPC 2.0 over HTTP, two endpoints:
  - `/api/v1/memory/rpc` — OAuth access token **or** api-key bearer (user PAT or service-account key) **or** cookie session, + required `X-Me-Space: <slug>` header. Memory data plane (`memory.*`) + space management (`principal.*`, `group.*`, `grant.*`, `invite.*`).
  - `/api/v1/user/rpc` — OAuth token, cookie, **or the user's own api key (PAT)**; a **service-account** key is admitted only for allow-listed reads (`whoami`, `space.list`), and `apiKey.create`/`delete` are session-only (keys can't mint keys). `whoami`, `apiKey.*`, `serviceAccount.*`, `space.*`.
  - `/api/v1/auth/*` is owned end-to-end by **better-auth** (social sign-in, OAuth 2.1 authorize/token, sessions/sign-out). The **web UI is served at root `/`** (any non-`/api` GET → static assets / SPA fallback), including the `/login` page the CLI authorize flow redirects to.
- **Auth**: humans authenticate via **OAuth (GitHub/Google)** → a **better-auth session** — an httpOnly cookie for the web UI, and for the CLI an OAuth 2.1 authorization-code + PKCE loopback flow (RFC 8252) yielding access/refresh tokens. For **headless** CLI use (a sandboxed harness / no local browser), `me login --device` runs the OAuth 2.0 **Device Authorization Grant** (RFC 8628) via better-auth's `deviceAuthorization` plugin: the CLI polls `/api/v1/auth/device/{code,token}` while the human approves the `user_code` at the web `/device` page; on approval it mints a better-auth **session** (no refresh token — a 7-day sliding session), presented back as an `Authorization: Bearer` token and accepted by the resource-server middleware via the `bearer` plugin (`getSession`). Users headlessly and service accounts can also use an **api key** (`me.<lookupId>.<secret>`: user PAT or service-account key). Api keys are **global** per-principal credentials, not space-bound: the same key works in any space the principal has been admitted to (the space comes from `X-Me-Space`, gated by `build_tree_access`). Service accounts are space-scoped principals, so their keys are useful only in that service account's space. better-auth owns session + OAuth-token storage (OAuth access/refresh tokens hashed sha256 at rest); api-key secrets are **core** sha256 (compared by equality in SQL), not argon2.
- **Harness surfaces (`me mcp`, capture hooks, harness shells)**: a plain `me` invocation always runs as the principal represented by the presented credential (session, OAuth token, user PAT, or service-account key). There is no impersonation, no `--as-agent`, no `ME_AS_AGENT`, and no `X-Me-As-Agent`. The one thing a harness still injects into every shell command is the discovery anchor `ME_PROJECT_DIR` — set by Claude's SessionStart hook (`me claude env` → `$CLAUDE_ENV_FILE`), opencode's `shell.env` plugin hook, and Codex/Gemini's command-string rewrites (`me codex env-hook` / `me gemini env-hook`, prepending an `export …; ` prefix via `renderExportPrefix` — see `packages/cli/codex/env-hook.ts` / `packages/cli/gemini/env-hook.ts`; both fail open and log an unrecognized payload's STRUCTURE, never its content, via `packages/cli/harness-shape-log.ts`, for a later `me doctor` to surface). The contract lives in `packages/cli/harness-contract.ts` and consists of two vars: `AI_AGENT` (inert identity metadata, per the `@vercel/detect-agent` convention) and `ME_PROJECT_DIR` (the discovery anchor `me` walks up from). Legacy compat: `X-Me-As-Agent` is silently ignored server-side; a legacy `agent:` field in `.me/config.yaml` or the global `~/.config/me/config.yaml` still validates and is preserved on write, but has no effect.
- **Embedding**: Vercel AI SDK; OpenAI `text-embedding-3-small` (1536-dim) in production; Ollama supported for local dev.
- **CLI**: `me` binary — `login`, `logout`, `whoami`, `space`, `group`, `access`, `service`, `apikey`, `memory` (+ top-level aliases like `me search`, `me create` — except `import`), `import` (the source group: `memories`/`claude`/`codex`/`opencode`/`granola`/`git`/`docs`/`slab`; `me memory import` and `me <tool> import` remain as aliases), `mcp`, `project` (per-project setup: `me project init`), `claude`/`codex`/`gemini`/`opencode`, `serve`, `pack`.

## Principals, members, spaces (terminology)

- **Principal** = the union **user | group | service account** (`principal.kind` = `'u'` | `'g'` | `'s'`). The space roster (`principal_space`) holds principals — users, service accounts, **and groups** (a group is rostered into its space on creation, so `principal_space` is the single source of truth for who/what belongs to a space). `principal.member_id` is a generated column equal to `id` for users/service accounts (NOT groups).
- **Member** = the **user/service-account** sense only — group members and api-key holders. So params split as `principalId` (roster / grants, any kind) vs `memberId` (group membership, api keys; u|s only). The space-roster surface is principal-centric (`principal.*` methods, `SpacePrincipal` type), reserving "member" for u|s.
- **Space**: identified by an immutable 12-char `slug` (which is the `me_<slug>` schema name and the `X-Me-Space` value) and a renamable `name`. `me space rename` changes only the name. No org / engine / shard concepts.
- **Admin**: `principal_space.admin` is *structural* authority — roster mutations (`principal.add`/`remove`), groups, and invitations (`invite.*`) — distinct from data ownership (owner@path via `tree_access`). Enumerating the **full** roster (`principal.list` — includes groups plus each principal's `admin`/timestamps) is admin-only; **any member** may `principal.resolve`/`lookup` (a targeted name↔id lookup) and `space.listMembers` (a **minimal** member listing — `id`/`kind`/`name`, u/s only, groups excluded). Member-level enumeration is deliberate: any member can already grant a path they own to any other member (`me access grant`) and a group admin (who need not be a space admin) must find who's addable (`me group add`), so discovering fellow members — but not admin metadata or group roster entries — is a member capability. Admin transfers through an admin group (a group whose own `principal_space.admin` is true) to its members who are **also direct space members**; service accounts may be made direct space admins but are discouraged and never count toward the last-admin invariant. A group is created non-admin and promoted/demoted via `set_group_is_space_admin` (`group.setIsSpaceAdmin` / `me group set-space-admin`), or created admin directly (`create_group(..., _is_space_admin)` / `me group create --space-admin`); demotion is gated by `enforce_last_admin`. (Distinct from a group *member's* admin flag, `group_member.admin`, which governs the group's own membership.) A space must always keep ≥1 *effective* admin (a **user** who is a direct admin or a direct member of an admin group — a group with no direct-member users doesn't count) — the `enforce_last_admin` trigger on `principal_space` + `group_member` rejects any remove/demote/group-member-removal that would drop the last one (SQLSTATE `ME001` → `LAST_ADMIN`), but exempts whole-space deletion.
- **Membership is explicit, not transitive**: a user/service-account's space membership is their own `principal_space` row, full stop — group membership alone never confers it. (Groups themselves *are* rostered — a group gets its own `principal_space` row on creation, which is what makes it resolvable/grantable by name — but that is the group's **own** roster entry, independent of conferral: being in a group never makes a *user/service-account* a space member.) A group's grants (and admin, if it's an admin group) are *effective* only for members who **also** hold a `principal_space` row; the gate lives in `member_tree_access`, so `build_tree_access` is empty for a non-member even if group rows were pre-staged. Joining (invite redemption / direct add / service-account creation) is the membership path. An admin can still **pre-stage** a member into a group before they join (`add_group_member` doesn't require membership); the group's grants stay dormant until they join. `remove_principal_from_space` scrubs the member's `group_member` rows along with the membership. Service accounts are space-scoped and deleted through `serviceAccount.delete`, which also deletes their bound admin group. Removal is admin-gated with one self-service exception — a user removing **themselves** (`me space leave`) — still bounded by the `enforce_last_admin` guard (a sole admin's self-leave → `LAST_ADMIN`). Groups are never removed this way (they leave only via deletion).

## Project Structure

```
packages/
  cli/          # CLI + MCP server (the `me` binary)
  claude-plugin/# Claude Code plugin (capture hooks, slash commands)
  client/       # TS client: createMemoryClient + createUserClient
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

# Run a test file directly (uses TEST_DATABASE_URL; default local 127.0.0.1) —
# fast, for iterating on one file:
./bun test packages/cli/mcp/install.test.ts

# Full suite (unit + integration) — defaults to the LOCAL Postgres container
# at 127.0.0.1:5432 (--parallel=2, 30s timeout); TEST_DATABASE_URL overrides.
./bun run test

# Fast inner loop (typecheck + lint + unit tests; no database, ~15s)
./bun run check

# Everything: check + full suite + the e2e suite (~30s against local Postgres)
./bun run check:full
```

**Important — verification runs against the local Postgres**: after making
code changes, run `./bun run check` (fast, no DB). Before committing, run
`./bun run check:full` — it defaults to the `me-postgres` Docker container
(if it isn't running: `docker start me-postgres || ./bun run pg:docker`). Only run
against ghost when explicitly asked to test against ghost. CI is the strict
gate: it runs every suite with `TEST_CI=1`, which disables conditional skips
— any new `describe.skipIf` gate **must** include `!process.env.TEST_CI` in
its condition (pattern: `packages/embedding/generate.test.ts`,
`e2e/cli.e2e.test.ts`) so CI never silently skips it.

> `packages/web` and `packages/docs-site` have their own tsconfigs, so they
> aren't part of the root `tsc` project. The root `typecheck` script chains in
> the web typecheck (`web:typecheck`), so `check`/`check:full` and CI **do**
> cover `packages/web`; `docs-site` stays uncovered (run its own typecheck).

### Database integration tests

`*.integration.test.ts` files run against a real PostgreSQL 18 with the
required extensions (citext, ltree, pgvector, pg_textsearch). Everything
defaults to the **local `me-postgres` Docker container** at 127.0.0.1:5432
(same image CI builds; `./bun run pg:docker` creates it). `test:db` is the focused
variant: it first reclaims orphaned test schemas, then runs **every**
`*.integration.test.ts` under `packages/` (the auth/core/space migration
suites plus the engine/server/worker suites), `--parallel=2`, 30s timeout:

```bash
./bun run test:db
```

A single integration file runs in seconds locally:

```bash
./bun test --timeout 30000 packages/database/core/migrate/migrate.integration.test.ts
```

**Ghost (only when explicitly asked to test against ghost)**: `testing_me` is
the dedicated ghost database — point `TEST_DATABASE_URL` at it explicitly.
Expect minutes instead of seconds (every statement pays WAN latency), and
always pass `--timeout 30000` for single files — bun's default 5s isn't
enough over the remote connection (a migrating `beforeAll` overruns it,
surfacing as a misleading "beforeEach/afterEach hook timed out"):

```bash
TEST_DATABASE_URL="$(ghost connect testing_me)" ./bun run test:db
```

Isolation is **schema-level** (ghost forbids `create database`): each test
provisions its own throwaway schema(s) — `core_test_<rand>` for core,
`auth_test_<rand>` for auth, `metest_<slug>` for the space *migration* tests — so
the suites are fully concurrent and parallel-safe across files. All migrations are
templated, so production uses `core` / `auth` / `me_<slug>` while these tests
target throwaway schemas and never touch real data. The space migration tests
deliberately use the `metest_` prefix (not production `me_`) so leftovers are
distinguishable by name alone. The **server** integration tests are the exception:
they exercise the real `provisionUser` / `provisionSpace`, so they create genuine
`me_<slug>` schemas and drop them in `afterAll` (only a hard-interrupted server
test leaks one — see below).

`test:db` first runs `test:db:clean` (`scripts/clean-test-schemas.ts`) to
reclaim orphaned `core_test_*` / `auth_test_*` / `metest_*` schemas left by
hard-interrupted runs. It is age-gated (only drops schemas older than 60 min, so
a concurrent `test:db` sharing the database is safe) and a no-op against a
production database — no pattern can match a real schema, **including `me_<slug>`**:
a server test's leaked `me_<slug>` is therefore *not* auto-reclaimed, so drop it
by hand if a run is killed mid-test. Use `test:db:clean:all` for a deliberate full
reset when nothing else is using the database.

### Harness smoke tests (manual only — never run automatically)

`packages/cli/harness-smoke/*.smoke.ts` launch a real harness binary
(`claude` and `opencode` verified live; `gemini` is scaffolded but
unverified — see each file's module doc) non-interactively and check that
the injected environment contract (`AI_AGENT`/`ME_PROJECT_DIR`) actually
lands in a real shell command's real environment. They exist because
`./bun run check`/`check:full`/CI only exercise the decision logic (what
a hook *should* output) — nothing runs an actual harness end-to-end.

**No `codex.smoke.ts`, deliberately**: Codex trusts a hook by the hash of
its definition text and gates a new/changed one behind an interactive
`/hooks` approval, with no documented non-interactive bypass. Every design
that avoids that gate either bakes in a guessed bypass flag or writes into
the developer's real `~/.codex/hooks.json` as a test side effect — both
rejected as too risky for a checked-in scaffold nobody has run for real. If
you need to smoke-test Codex, do it manually: run `me codex install` for
real, approve `/hooks` once, then invoke `codex exec` by hand with the
`markerPrompt(REVEAL_COMMAND)` helper from `_shared.ts`.

They are named `*.smoke.ts`, not `*.test.ts`, specifically so `bun test
packages` (the full `test` suite) never discovers them — and even run
directly, each test also self-skips unless `ME_HARNESS_SMOKE=1` is set, since
a live run makes a real model call under whatever account is authenticated
on this machine and **spends real API tokens**. **Always ask the user
before actually running one of these** — building/editing the script is
free, executing it is not. Run them explicitly:

```bash
ME_HARNESS_SMOKE=1 ./bun run test:harness-smoke
```

A test silently skips (not fails) when its harness binary isn't installed
(`Bun.which(...)` returns null) — run `claude --version` etc. first if a test
you expected to run reports 0 tests exercised. Each test builds a scratch
project dir and a scratch `me` binary (shadowing whatever `me` is actually
installed on `PATH`, via `writeMeWrapper()` in `_shared.ts`) so it always
exercises the CURRENT checkout's code, never a stale global install — and
strips the contract vars from its own process env before spawning
(`cleanEnv()`), since this very test suite may itself be running inside a
live-injected harness session.

## Style Guides

**TypeScript**: Biome for linting and formatting. Config in `biome.json`. Treat
Biome warnings as defects to fix, not background noise to ignore. If `./bun run
check` reports warnings, address them in the same change unless they are clearly
unrelated and unsafe to touch; in that case, call them out explicitly rather than
letting them silently linger.

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

**Migration footgun — `CREATE OR REPLACE FUNCTION` can't change a return type or
rename an input parameter** (both `42P13`), and changing the *arg types* silently
leaves the old overload behind. All three are invisible in CI (fresh schemas) but
crash a boot-time migration against an existing dev/prod DB. So when a function's
signature changes, wrap its `create or replace` in a `{{fn …}}` block
(`template()` in `migrate/kit.ts`, helpers in `migrate/function_signature.sql`) —
it drops a stale-signatured definition before and asserts the result after, so a
drift fails CI loudly instead of churning prod:

```sql
{{fn get_memory(_tree_access jsonb, _id uuid) returns table(id uuid, name text)}}
create or replace function {{schema}}.get_memory(_tree_access jsonb, _id uuid)
returns table (id uuid, name text) as $func$ ... $func$ language sql;
{{endfn}}
```

Write each header arg as `name type` — the parameter **name** is part of the
signature (a rename is a `42P13` just like a type change), the type without a
typmod (`halfvec`, not `halfvec(1536)`; it's canonicalized via regtype). Never
wrap a deliberately overloaded name like `count_tree`.

## Key Design Decisions

- **One DB, one pool**: `auth` + `core` + every `me_<slug>` live in one Postgres database behind one postgres.js pool (plus a dedicated worker pool). Sharding / pgdog distribution is deferred; the per-slug schema model keeps a future re-split cheap.
- **Single memory table per space**: all memory lives in `me_<slug>.memory`. Complexity comes from conventions in `meta` and `tree`, not schema proliferation.
- **Database-native**: PostgreSQL extensions (ltree, pgvector/halfvec, JSONB GIN, tstzrange, BM25) instead of application-layer abstractions.
- **Access via `tree_access`, not RLS**: RLS was unperformant. `build_tree_access` produces a `_tree_access` jsonb passed into the space functions; there is no `me.user_id` GUC. Three levels (read/write/owner); an owner grant delegates access-management within its subtree (owner@root = the whole space).
- **Two endpoints, two auth modes**: memory RPC (any bearer — OAuth token or api key — or cookie, + `X-Me-Space`) vs user RPC (OAuth token, cookie, or the user's own PAT; service-account keys are admitted only for allow-listed reads; key mint/revoke session-only). The middleware resolves the credential via `extractBearerToken` (api key → `core.validateApiKey`, else → `verifyOAuthToken`) and falls back to `betterAuth.api.getSession` for the cookie (Origin-CSRF-gated).
- **Hosted web UI** (same `packages/web` build, two modes): `me serve` proxies `/rpc` locally (browser carries no creds); the API server also serves the UI at root (`https://api.memory.build/` in production) with **httpOnly-cookie** browser login (cookie carries the same session token; Origin-allowlist CSRF gate for cookie creds). Full design + runbook: `DEVELOPMENT.md` → "Hosted web UI" and the `DECISIONS_FOR_REVIEW.md` entry.
- **Principal vs member** terminology (see above): principal = u|s|g; member/`memberId` = u|s.
- **CLI credentials**: split across `~/.config/me/` — **`config.yaml`** (non-secret: default server + per-server **active space** / the X-Me-Space) and **`credentials.yaml`** (0600, secret session-token *fallback* only). The **session token** lives in the OS keychain when available (macOS `security`, Linux `secret-tool` via libsecret; `ME_NO_KEYCHAIN=1` forces off), else in `credentials.yaml` (empty/absent on keychain hosts); a pre-split `credentials.yaml` is migrated on first read. `me logout` clears the session secret but keeps the non-secret config (so re-login resumes). **Api keys are never persisted** — user PATs and service-account keys only ever come from `ME_API_KEY`/`--api-key`; `apiKey.create` prints the key once for the operator to place where it runs. Env: `ME_SERVER` / `ME_API_KEY` / `ME_SPACE` / `ME_SESSION_TOKEN` / `ME_NO_KEYCHAIN` / `ME_CONFIG_DIR` / `ME_PROJECT_DIR`. A per-project **`.me/config.yaml`** (walk-up from cwd, or `--config-dir`/`ME_CONFIG_DIR` for an exact dir, or `--project-dir`/`ME_PROJECT_DIR` — an ANCHOR that replaces cwd as the walk-up origin, set by harness adapters into every shell command they run) pins `server` + `space` (+ optional full no-slug `tree` for integrations); a gitignored `.me/config.local.yaml` overrides it per-field. A legacy `agent:` field is still accepted and preserved on write for backwards compatibility, but has no effect. Below cwd walk-up sits a validated last-resort backstop (today: Claude's `CLAUDE_PROJECT_DIR`, accepted only if it contains `.me/` — it mis-resolves to the main checkout under `claude -w`, so it's demoted below cwd on purpose). Precedence: `--flag > ME_* env > .me (.local > committed) > global config.yaml > default`. Resolution lives in `packages/cli/project-config.ts`, wired into `resolveServer`/`resolveSpace`/`resolveCredentials` (so `me mcp` inherits it) and the capture hooks / `me import git` (which use the `tree` as the project root, no slug appended). **Credential-safety gate**: a `.me`-sourced `server` is only honored if it's in a **trusted list** (`DEFAULT_TRUSTED_SERVERS` = prod + dev, extendable via `server_whitelist` in the global config, auto-extended by `me login --server`) — otherwise a fatal `ProjectConfigError`, so an untrusted repo's `.me` can't redirect a global api key / `ME_SESSION_TOKEN` to an attacker (`--server`/`ME_SERVER`/stored `default_server` are the user's own choice, ungated). See `docs/project-config.md`.
- **Header constants** (`CLIENT_VERSION_HEADER`, `SPACE_HEADER`) live in `@memory.build/protocol/headers`.
- **Error reporting**: always import `reportError` from `@memory.build/database/telemetry`, never `@pydantic/logfire-node` directly. The wrapper writes the full error (stack + nested pg `cause`) to **stderr synchronously** *and* forwards to logfire — so a crash that exits before logfire's buffered OTLP exporter flushes (e.g. a failed boot migration) still leaves the cause in `kubectl logs`. (logfire's console processor is span-only, so a bare `reportError` is invisible on a crash.) `info` / `span` / `warning` stay imported directly from logfire.
- **MCP compatibility**: all tool parameters are required (nullable for optional). Uses `z.record(z.string(), z.any())` for meta instead of `z.record(z.unknown())` (which crashes the MCP SDK).
- **create / batchCreate conflict semantics**: the idempotency key is a named row's `(tree, name)` slot (name wins over id), else the explicit id. `onConflict` governs a clash on that key: `error` (default) raises CONFLICT, `replace` overwrites in place when content/meta/temporal differ (a no-op when identical; the id-path also compares tree/name since it can move/rename), `ignore` skips. create/batchCreate report a per-row `{id, status}` (`status` = `inserted` | `updated` | `skipped`); batchCreate returns `{results: [...]}`, one entry per input in input order (so a skip is visible and ids map back to inputs). The session/git importers pass `onConflict: 'replace'` and stamp `meta.importer_version` (deterministic meta, no per-run timestamp), so an unchanged re-import is a no-op while a version bump makes meta differ and re-renders. The file importers (`me import memories`, `me_memory_import`, `me pack install`) pass `onConflict: 'ignore'` so a re-import/re-install is a no-op. (There is no `replaceIfMetaDiffers` — content-aware `replace` subsumed it.)

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
