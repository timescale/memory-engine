# TODO

Tracked follow-up work. For the in-progress Bun.SQL → postgres.js driver swap,
see `CLAUDE.md` → "Database driver migration" (status + per-file recipe).

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

- [ ] Add a shared `normalizeTreePath(input): string` util (home: alongside the
      slug helpers in `packages/database/space`, or a small `path.ts`). Rules:
      split on `/[./]+/`, drop empty segments, validate each is a legal ltree
      label, join with `.`. So `/foo/bar`, `foo/bar`, `foo.bar` → `foo.bar`; and
      `""`, `/`, `.` → `""` (root). Use it in **every** user-facing entry point
      so they behave identically. Wire in Phase 4 with the memory/grant RPC +
      CLI + MCP.
- [ ] Decide the canonical **output/display** form (echoed in search results,
      `grant list`, etc.): dot-style `work.projects` (matches current docs) vs
      filesystem-style `/work/projects`. Input stays lenient; output is one form.

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
