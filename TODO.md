# TODO

Tracked follow-up work. For the in-progress Bun.SQL → postgres.js driver swap,
see `CLAUDE.md` → "Database driver migration" (status + per-file recipe).

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

- [x] Done (2026-06-05) — `me apikey create` now maps the server `NOT_FOUND` to
      an actionable message ("Agent '<agent>' isn't in this space yet — run
      'me agent add <agent>' first"). Added a reusable `isAppErrorCode` helper to
      util.ts. (Auto-adding the agent was considered but skipped — silently
      changing space membership as a side effect of minting a key is surprising.)

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

- [x] Done (2026-06-05) — added `complete_embedding(queue_id, memory_id,
      embedding_version, embedding)` (version-guarded memory write + atomic
      `completed`/`cancelled` queue finalization, returns the outcome),
      `fail_embedding(queue_id, error)` (record transient error, leave outcome
      NULL), and `release_embedding(queue_id)` (attempt-undo for rate limits) to
      `space/migrate/idempotent/003_embedding_queue.sql`. `process.ts` calls them
      via `tx.unsafe` (like the existing claim/prune); it now holds zero inline
      DML. Existing process integration tests regression-guard the behavior; new
      tests cover the functions directly (incl. the write-back-time version
      mismatch → `cancelled`, and fail/release no-op once terminal).

## Worker: batch the embedding write-back (fewer DB round-trips)

`processBatch`'s write-back loops over each claimed row in its own `sql.begin`
transaction, calling `complete_embedding` / `fail_embedding` one row at a time —
so a batch of N claimed rows costs ~N transactions / round-trips on the
write-back side (the claim is already a single call). Over a remote DB that
per-row latency dominates a batch.

- [ ] Make the write-back set-based: a batch SQL function (e.g.
      `complete_embeddings(_rows jsonb)` taking
      `[{queue_id, memory_id, embedding_version, embedding}]`, doing the
      version-guarded memory updates + queue finalization in one statement-pair
      and returning per-row outcomes), called once per batch instead of per row.
      Do the same for the transient-fail and rate-limit `release` paths (one
      call covering the whole batch). Keep the version-guard
      `completed`/`cancelled` semantics (data-driven, not errors).
- [ ] Decide error isolation: one transaction for the batch is simplest but a
      single poison row (e.g. a malformed vector) would fail the whole batch.
      Consider a per-row fallback when the batched call errors, so one bad row
      doesn't block its siblings (which today each commit independently).

## Decision: `core` and `space` are one package (`@memory.build/database`)

Resolved (2026-06): merged `packages/core` + `packages/space` into a single
`@memory.build/database`, kept as separate `core/` and `space/` modules. The team
co-locates the control plane and data plane in one database/deployment, and pgdog
sharding/distribution of spaces is off the table for now. The per-slug schema model
and the `set local pgdog.shard` code stay in the `space/` module, so re-splitting
later is cheap if distribution returns.

- [x] Done (2026-06-05) — Biome `noRestrictedImports` overrides in `biome.json`
      forbid `packages/database/space/**` from importing core (`**/core`,
      `**/core/**`, or the package root `@memory.build/database` which re-exports
      it) and symmetrically forbid core from importing space, each with an
      explanatory message. Verified it fires on a cross-import in both
      directions.

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
      mapped to `~.…` on output for the caller's own home. Labels allow
      `[A-Za-z0-9_-]` (PG16+ hyphens). Malformed input → `VALIDATION_ERROR`.
- [x] Output form decided (2026-06-05): **dot is the canonical separator
      everywhere** (`work.projects`, and home as `~.blah`); slashes are accepted
      on input but never emitted. Docs already use dots, so no doc change needed.
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
