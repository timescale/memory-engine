# TODO

Tracked follow-up work. For the in-progress Bun.SQL → postgres.js driver swap,
see `CLAUDE.md` → "Database driver migration" (status + per-file recipe).

## Space owner flag (protect destructive ops)

`space.delete` (and `space.rename`) are currently gated on space-admin
(`principal_space.admin`, which is transitive through admin groups). Deleting a
space drops the whole `me_<slug>` schema (all memories), so any admin — including
one who inherited admin via a group — can destroy everything.

- [ ] Consider a distinct space-**owner** notion (e.g. a `principal_space.owner`
      flag, or treating owner@root as the gate) for the truly destructive ops
      (delete, and maybe transfer-ownership), keeping admin for routine
      structural management (groups, members, grants). Decide whether owner is
      transitive through groups (probably not) and how ownership is transferred.

## Reconsider: api keys for users (not just agents)

Keys are currently agent-only (`apiKey.create` is gated by `requireOwnedAgent`;
humans authenticate via session). The intended CLI surface treats `ME_API_KEY`
as pointing to a "user|agent" and `me apikey create` defaulting to self, which
implies users can mint their own keys.

- [ ] Decide whether to allow user-owned api keys. `validate_api_key` already
      returns the principal regardless of kind, and `authenticateSpace` would
      work unchanged — so it's mostly relaxing the `apiKey.create` gate to allow
      `member == self` (a user) in addition to agents the caller owns. Weigh
      against the "humans use sessions only" security stance.

## CLI: `me apikey create <agent>` when the agent isn't in the space

`apiKey.create` requires the agent already be a member of the active space
(`requireOwnedAgent` → NOT_FOUND otherwise). `me apikey create <agent>` surfaces
that raw NOT_FOUND, so the user has to know to run `me agent add <agent>` first.

- [ ] Improve the UX: either pre-check membership in `me apikey create` and emit
      an actionable hint ("agent X isn't in this space — run `me agent add X`"),
      or offer to add it (self-service `principal.add`, which is already allowed
      for your own agent) before minting the key. Map the server NOT_FOUND to the
      friendlier message at minimum.

## Space invitations

The CLI spec includes `me space invite` / `invite list` / `invite revoke`
(invite a user by email into a space with an initial role/grant). Deferred from
4E — it's a new subsystem.

- [ ] Design + build space-scoped invitations: a core table (space_id, email,
      role/grant, token, status, expiry), RPC on the space endpoint
      (invite.create/list/revoke + accept on the user endpoint), and the email/
      link delivery. Mirrors the device-flow consent UX where relevant.

## Worker: call space SQL functions instead of raw queries

The embedding worker's write-back in `packages/worker/process.ts` still issues
raw `UPDATE embedding_queue …` / `UPDATE memory SET embedding …` statements,
against the "logic in DB functions, TS calls functions" principle the rest of
the cutover follows.

- [ ] Add space SQL functions for the write-back path (e.g.
      `complete_embedding(queue_id, memory_id, embedding_version, embedding)`
      that does the version-guarded memory update + sets the queue outcome to
      `completed`/`cancelled` atomically, plus `fail_embedding(queue_id, error)`
      and the rate-limit `release_embedding(queue_id)` attempt-undo), and have
      `process.ts` call those instead of inline SQL. Claim already goes through
      `claim_embedding_batch`; this finishes the job for the write-back/prune
      side so the worker holds no embedded SQL.

## Decision: `core` and `space` are one package (`@memory.build/database`)

Resolved (2026-06): merged `packages/core` + `packages/space` into a single
`@memory.build/database`, kept as separate `core/` and `space/` modules. The team
co-locates the control plane and data plane in one database/deployment, and pgdog
sharding/distribution of spaces is off the table for now. The per-slug schema model
and the `set local pgdog.shard` code stay in the `space/` module, so re-splitting
later is cheap if distribution returns.

- [ ] Keep `space/` free of `core/` imports (and vice versa) so the re-split escape
      hatch stays open — worth a Biome `noRestrictedImports` rule to enforce it.

## Consolidate duplicated test-utils

- [x] Done — the generic, driver-level helpers (`resolveTestDatabaseUrl`, `connect`,
      `expectReject`, and schema introspection: `schemaExists`, `tableExists`,
      `listTables`, `listFunctions`, `listTriggers`, `extensionInstalled`,
      `columnType`, `listIndexes`, `getIndexDef`, `getIndexReloptions`,
      `appliedMigrations`, `getSchemaVersion`) now live once in
      `packages/database/migrate/test-utils.ts`. `core/migrate/test-utils.ts` and
      `space/migrate/test-utils.ts` `export *` from it and add only their
      provisioning (`TestCore`/`withTestCore`/`randomCoreSchema`;
      `TestSpace`/`withTestSpace`/`randomSlug`/`testSchema`), so the test files are
      unchanged. Verified: typecheck/lint clean, unit + ghost db suites pass.
- [ ] `engine`/`accounts` still carry their own `tableExists`/`schemaExists` copies.
      They're separate packages, so sharing with them needs a dev-only package
      (or fold them in during the postgres.js rollout).

## Harden `search_path` on SQL functions (+ maybe move extensions off `public`)

All the schema SQL functions currently set
`search_path to pg_catalog, {{schema}}, public, pg_temp`. They can be tightened
(every object reference is already schema-qualified, and none create temp
objects):

- [ ] Auth (and likely core/space) data functions → `pg_catalog, public`: drop
      `{{schema}}` (nothing unqualified) and `pg_temp` (so a temp object can never
      shadow). The SECURITY DEFINER `update_updated_at` trigger fn can go all the
      way to `search_path = ''` — it only uses `pg_catalog.now()` + the NEW record.
- [ ] `public` only has to stay because of `citext` (the `users.email` column +
      the `_email::citext` compare; its `=` operator can't be cleanly
      schema-qualified in `a = b`). Consider installing extensions
      (`citext`, and engine's `ltree`/`vector`/`pg_textsearch`) into a dedicated
      `extensions` schema instead of `public`; then the path becomes
      `pg_catalog, extensions` and `public` drops out entirely. This touches the
      migrate bootstrap (`ensureExtension` installs `with schema public`) — decide
      holistically before changing the function `search_path`s.

## User-facing tree-path convention (lenient input → canonical ltree)

Tree paths are stored as ltree (dot-separated; the root is the empty path,
exported as `core.ROOT_PATH`). Internally everything stays ltree-native (the
store layer, the SQL functions, `provisionUser`). At the **user-facing boundary**
(RPC handlers, CLI, MCP) we want lenient input normalized once to that canonical
form — the right convention is what's natural for users, not what ltree accepts.

- [x] Done — `packages/database/space/path.ts` exports `normalizeTreePath`
      (strict, concrete paths), `normalizeTreeFilter` (lenient, lquery/ltxtquery
      passes through), `homePrefix`, and `denormalizeTreePath`. Wired **server-side**
      in the space RPC handlers (`rpc/memory/memory.ts` + `grant.ts` via
      `inputTreePath`/`inputTreeFilter`/`displayTreePath` in `support.ts`), which
      is the single chokepoint for CLI + MCP + web (they send raw input; the
      server normalizes). Includes `~` home directories: a leading `~` expands to
      `home.<principalId-without-hyphens>` (the authenticated caller), reverse-
      mapped to `~/…` on output for the caller's own home. Labels allow
      `[A-Za-z0-9_-]` (PG16+ hyphens). Malformed input → `VALIDATION_ERROR`.
- [ ] **Output form is only half-decided.** The caller's home reverse-maps to
      slash-style `~/a/b`, but non-home paths still display dot-style
      `work.projects`. Decide whether to unify all output on one separator
      (dot vs slash) — if slash, update the docs (which use dot) and the
      `denormalizeTreePath` non-home branch.
- [ ] Reverse-mapping only covers the **caller's own** home (other principals'
      homes show the raw `home.<uuid>.…`). Fine for now; revisit if listing
      other members' home paths becomes common (would need a uuid→`~user` or
      handle lookup).

## Consolidate the migration runner logic

- [x] Done — the shared machinery lives in `packages/database/migrate/kit.ts`:
      advisory locking (`advisoryLockKey`, `acquireAdvisoryLock`), session timeouts
      (`applySessionTimeouts`), extension / Postgres-version preconditions
      (`ensurePostgresVersion`, `ensureExtension`, `ensureRequiredExtensions`,
      `REQUIRED_EXTENSIONS`), schema checks (`doesSchemaExist`,
      `assertSchemaOwnership`, `isValidSchemaName`), `{{…}}` `template` rendering,
      SQL-file execution with error-location logging (`executeSqlFile`), and the
      incremental-once / idempotent-always `runSchemaMigrations` runner — all
      parameterized by a `label` (drives span/attribute/log names) + `dir`.
      `migrateCore` / `migrateSpace` / `bootstrapSpaceDatabase` are now thin
      orchestrators holding only their schema-specific bits (options, SQL lists,
      slug/shard handling, template vars). Verified: typecheck/lint clean,
      unit + ghost db suites pass. (bootstrap's lock moved from a hardcoded
      single-key id to the shared two-key derived lock.)

## OS keychain for CLI credentials

The CLI credentials file (`~/.config/me/credentials.yaml`, 0600) stores the
session token + active space in plaintext. (Api keys are never stored — they
come from `ME_API_KEY` only.) A code TODO marker lives in
`packages/cli/credentials.ts`.

- [ ] Move the session token into the OS keychain (macOS `security`, Linux
      `secret-tool`, Windows credential manager) with a fallback to the 0600
      file when no keychain is available (CI, headless Linux). The file would
      then hold only non-secret pointers (`default_server`, `active_space`).

## Refresh `docs/` for the principal / space model

The `docs/` pages (getting-started, concepts, access-control, `cli/*`, `mcp/*`)
still describe the retired engine / org / role / accounts model. `CLAUDE.md` is
now the authoritative summary of the current design.

- [ ] Rewrite the docs to the new model: principals (user | agent | group),
      spaces (immutable slug / renamable name, `X-Me-Space`), 3-level
      tree-access grants, session-vs-api-key auth, and the
      `me space/group/access/agent/apikey/memory` command surface. Update
      `docs/cli/*` (drop engine/org/invitation/user/owner/role; add
      space/group/access/agent) and `docs/mcp/*`. The docs-site renders these.

## Deploy: env rename coordination (Phase 5)

Phase 5 renamed the server's required DB env var and removed the accounts DB.
The server throws at boot if `DATABASE_URL` is unset (no back-compat fallback,
by design).

- [ ] With the `multiplayer` → `main` deploy: set `DATABASE_URL` (was
      `ENGINE_DATABASE_URL`) in every environment; `ACCOUNTS_DATABASE_URL` is no
      longer read; pool tunables renamed `ENGINE_POOL_*` → `DB_POOL_*` and
      `WORKER_ENGINE_*` → `WORKER_*` / `WORKER_DB_*`. The old `accounts` schema
      (and any old RLS `me_<slug>` engine schemas) are now orphaned — no
      migration drops them; remove manually if a non-fresh DB ever runs this.

## `me serve` web UI: finish + verify

`packages/web` is the React UI for `me serve`. Its bundled assets
(`packages/cli/serve/web-assets.generated.ts`) are an empty placeholder,
`packages/web` is excluded from the root typecheck (and has pre-existing Monaco
typecheck errors), and there is no serve → `/api/v1/memory/rpc` integration
test. The `/rpc` proxy + web client are migrated (session token + `X-Me-Space`)
but unproven at runtime.

- [ ] Build/bundle the web UI (`scripts/bundle-web-assets.ts`), fix the Monaco
      typecheck errors, and add an end-to-end check that the `me serve` `/rpc`
      proxy reaches the memory endpoint. Decide whether `packages/web` should be
      in CI / the root typecheck.
