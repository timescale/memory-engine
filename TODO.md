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

## Consolidate the migration runner logic (now an internal module)

`packages/database/core/migrate/migrate.ts`, `.../space/migrate/migrate.ts`, and
`.../space/migrate/bootstrap.ts` duplicate most of the migration machinery:

- advisory locking (`advisoryLockKey`, `acquireAdvisoryLock`, retry/backoff)
- SQL-file execution with error-location logging (`executeSqlFile`,
  `logPostgresSqlLocation`, `sqlLocation`, `sqlContext`)
- extension / Postgres-version preconditions (`ensureExtension`,
  `ensurePostgresVersion`, `REQUIRED_EXTENSIONS`)
- `{{template}}` rendering
- the incremental-once / idempotent-always runner, with version + migration tracking
- telemetry span wrapping

- [ ] Extract into a shared internal module (e.g. `packages/database/migrate/_kit.ts`)
      parameterized by schema name, the ordered incremental/idempotent SQL lists, and
      template vars. `migrateCore` / `migrateSpace` / `bootstrapSpaceDatabase` become
      thin callers, leaving each `migrate.ts` with only its schema-specific bits.
