# TODO

Tracked follow-up work. For the in-progress Bun.SQL → postgres.js driver swap,
see `CLAUDE.md` → "Database driver migration" (status + per-file recipe). The two
consolidations below are best done as part of that rollout, since it touches every
package's migration and test code anyway.

## Open question: should `core` and `space` be one package?

They're separate packages today (`packages/core`, `packages/space`) with no runtime
dependency between them. The consolidations below keep bumping into that split —
sharing code requires a separate shared/dev package rather than a plain internal
module. So: should they merge into one package?

- **Merge** → sharing the test-utils and migration runner becomes trivial (internal
  modules, no extra package); they're conceptually the two halves (control plane +
  data plane) of one system.
- **Keep separate** → preserves a clean boundary (space already has zero references to
  core) and keeps the door open to deploying/scaling them differently (e.g. space
  schemas sharded across many DBs via pgdog, core centralized).

Decide this first — it determines whether the consolidations below land as internal
modules (merged) or a shared package (separate).

## Consolidate duplicated test-utils

`packages/core/migrate/test-utils.ts` and `packages/space/migrate/test-utils.ts`
duplicate ~110 lines of generic, driver-level helpers: `resolveTestDatabaseUrl`,
`connect`, `expectReject`, and schema introspection (`schemaExists`, `tableExists`,
`listTables`, `listFunctions`, `listTriggers`, `appliedMigrations`,
`getSchemaVersion`). `packages/engine` and `packages/accounts` also carry their own
copies of some of these (~4 repo-wide copies of `tableExists`/`schemaExists`).

- [ ] Extract the generic helpers into a shared **dev-only** package (e.g.
      `@memory.build/db-testkit`) added as a `devDependency` where needed. Keep
      package-specific provisioning in each package: `TestCore`/`TestSpace`,
      `randomCoreSchema`/`randomSlug`, `columnType`, the index helpers. Test-only,
      so it doesn't couple the packages at runtime.
- [ ] Move `engine`/`accounts` test-utils onto it too, removing the older duplicates.

## Consolidate the migration runner logic

`packages/core/migrate/migrate.ts`, `packages/space/migrate/migrate.ts`, and
`packages/space/migrate/bootstrap.ts` duplicate most of the migration machinery:

- advisory locking (`advisoryLockKey`, `acquireAdvisoryLock`, retry/backoff)
- SQL-file execution with error-location logging (`executeSqlFile`,
  `logPostgresSqlLocation`, `sqlLocation`, `sqlContext`)
- extension / Postgres-version preconditions (`ensureExtension`,
  `ensurePostgresVersion`, `REQUIRED_EXTENSIONS`)
- `{{template}}` rendering
- the incremental-once / idempotent-always runner, with version + migration tracking
- telemetry span wrapping

- [ ] Extract this into a shared migration util (e.g. `@memory.build/migrate-kit`)
      parameterized by schema name, the ordered incremental/idempotent SQL lists, and
      template vars. `migrateCore` / `migrateSpace` / `bootstrapSpaceDatabase` then
      become thin callers, leaving each `migrate.ts` with only its schema-specific bits.
