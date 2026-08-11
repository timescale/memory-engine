---
title: Database Migrations and Versioning
tags: [database, migrations, versioning, postgres, spaces]
---

# Database Migrations and Versioning

Migrations keep the database schema and database-resident behavior compatible
with the running server. They run for three schema families in one PostgreSQL
database:

| Schema family | Role |
| --- | --- |
| `auth` | Authentication and OAuth state. |
| `core` | Spaces, principals, grants, invitations, and API keys. |
| `me_<slug>` | One memory data schema for each space. |

Every schema carries a singleton `version` row and a `migration` ledger. The
version records the latest schema-version migrator that touched the schema; the
ledger records exactly which incremental migrations have been applied.

## Migration kinds

Migrations are ordered by filename and divided into two categories:

| Kind | Purpose | Execution |
| --- | --- | --- |
| Incremental | One-time schema or data transitions, including backfills. | Applied once and recorded in the migration ledger. |
| Idempotent | Current definitions of functions, triggers, and other replaceable database behavior. | Re-applied on every migration pass. |

Incremental files are immutable history: never edit an incremental that may have
run against an existing schema. Add a new incremental instead. Idempotent files
are living definitions and should be updated in place as their behavior changes.

This split is necessary because much of Memory Engine's behavior lives in SQL
functions. Tracking only versioned one-time files would leave existing spaces
with stale function bodies after a server deployment.

## Provisioning and migration

New space provisioning creates the schema plus empty `version` and `migration`
tracking tables, then runs the same migration sequence used for existing spaces.
When provisioning is composed into a caller's transaction, the new schema and
the related control-plane changes succeed or roll back together.

Standalone migration acquires a transaction-scoped advisory lock per schema and
requires the current database user to own that schema. This serializes concurrent
server replicas and prevents accidental migration by an unprivileged connection.
The migration transaction also verifies the supported PostgreSQL and extension
versions before applying schema-specific SQL.

Space migrations allow a long-running backfill statement, but cap the whole
migration transaction at 20 minutes. This lets a legitimate table-sized backfill
complete while still failing a genuinely stuck deployment. Lock and idle
transaction timeouts remain short to avoid prolonged contention.

## Startup reconciliation

Server startup migrates `core` and `auth`, then enumerates every existing space
and runs its space migration. Incrementals already present in the ledger are
cheap no-ops; idempotent definitions are refreshed.

Every space is attempted so failures are individually reported. If any space
fails to migrate, startup fails rather than serving a deployment whose database
behavior may be stale. The per-space advisory lock makes this safe when multiple
server replicas start concurrently.

## Schema versions and downgrade protection

Each schema family has an independent semantic schema version in code. Before a
migration runs, the runner compares that version with the schema's stored
version. A server older than the stored schema version refuses to run, preventing
older SQL definitions from being reapplied to a newer database.

Migration runs proceed even when the versions are equal because idempotent SQL
must be refreshed. The incremental ledger, not the version row, is the source of
truth for which one-time migrations have completed.

## SQL templating and function signatures

Migration SQL is templated so the same files can target production schemas and
isolated test schemas. Space migrations also substitute database configuration
such as embedding dimensions and index parameters.

PostgreSQL cannot use `create or replace function` to change a function's return
type or input parameter names, and a changed argument type can leave an obsolete
overload behind. Function definitions whose signatures may change use a
`{{fn name(args) returns result}}` header. The migration runner expands it into
a pre-create stale-signature drop and a post-create signature assertion.

This makes signature drift fail during a fresh test migration instead of only
failing when an existing production schema is upgraded. Parameter defaults are
not part of that signature contract; removing a default may require an explicit
guarded drop before recreating the function.
