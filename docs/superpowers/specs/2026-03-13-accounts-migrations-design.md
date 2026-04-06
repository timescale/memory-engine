# Accounts Migration System Design

**Date:** 2026-03-13
**Status:** Draft

## Overview

A database migration system for the `accounts` package - a single, unsharded database handling users, authentication, orgs, billing, etc. This design covers only the migration infrastructure; schema design is future work.

## Background

Memory Engine uses a sophisticated migration system (`packages/engine/migrate/`) that handles multi-tenant sharding with dynamic schemas, per-schema advisory locks, and extensive template variables. For the accounts database - a single, fixed schema - we can simplify significantly.

**Decision:** Copy and simplify the engine migration code rather than:
- Extracting a shared library (premature abstraction)
- Writing from scratch (would miss edge cases already handled)

## Package Structure

```
packages/accounts/
├── migrate/
│   ├── index.ts          # Public API exports
│   ├── runner.ts         # Core migration execution
│   ├── template.ts       # SQL template substitution
│   ├── test-utils.ts     # TestDatabase helper for tests
│   ├── runner.test.ts    # Unit tests
│   ├── template.test.ts  # Template tests
│   └── migrations/
│       ├── sql.d.ts      # TypeScript declaration for .sql imports
│       └── 001_create_schema.sql  # Bootstrap migration
└── package.json
```

## Public API

```typescript
// packages/accounts/migrate/index.ts

// Run migrations against accounts schema
migrate(sql: SQL, config?: AccountsConfig, appVersion?: string): Promise<MigrateResult>

// Preview pending migrations without applying
dryRun(sql: SQL, config?: AccountsConfig): Promise<{pending: string[], applied: string[]}>

// List all known migrations
getMigrations(): ReadonlyArray<{name: string}>

// Template utilities (for advanced use / testing)
template(sql: string, vars: Record<string, unknown>): string
defaultConfig: Required<AccountsConfig>
```

### Types

```typescript
interface AccountsConfig {
  schema?: string;  // default: "accounts"
  // Future template vars can be added here
}

interface MigrateResult {
  schema: string;
  status: "ok" | "skipped" | "error";
  applied: string[];  // migrations applied this run
  error?: Error;
}
```

### Removed from Engine API

- `migrateAll` / batch operations (single schema, not needed)
- `discoverEngineSchemas` / schema discovery (fixed schema)
- `provisionEngine` (no dynamic schema creation)
- `bootstrap` (accounts won't need pgvector/pg_textsearch extensions)
- Engine-specific config vars (embedding_dimensions, bm25_*, hnsw_*)

## Schema Version Tracking

The database tracks its schema version to prevent running older app code against a newer database:

```sql
create table {{schema}}.version
( version text not null check (version ~ '^\d+\.\d+\.\d+$')
, at timestamptz not null default now()
);
create unique index on {{schema}}.version ((true));  -- ensures only one row ever
insert into {{schema}}.version (version) values ('0.0.0');
```

**Version check logic:**

1. Before running migrations, read `version` from the table
2. Compare app version vs DB version using semver
3. If app version < DB version: **throw error** - prevents rollback issues
4. Run migrations
5. If app version > DB version: update the version table

This ensures:
- You can't accidentally run old code against a newer database
- The version bumps automatically when deploying newer code
- Clear error message tells you to upgrade the application

**API addition:**

```typescript
// Get current database schema version
getVersion(sql: SQL, config?: AccountsConfig): Promise<string>
```

## Migration Table Schema

```sql
create table if not exists {{schema}}.migration
( name text not null primary key           -- e.g., "001_users"
, applied_at_version text not null         -- app version that applied it
, applied_at timestamptz not null default pg_catalog.clock_timestamp()
)
```

## Concurrency Handling

Advisory locking prevents concurrent migration runs, with retry logic for transient contention:

```typescript
// Inside transaction:
const lockId = hashtext('accounts');  // fixed lock key

// Retry up to N times with exponential backoff
const maxRetries = 5;
const baseDelayMs = 100;

for (let attempt = 0; attempt < maxRetries; attempt++) {
  const [{ acquired }] = await tx`select pg_try_advisory_xact_lock(${lockId}) as acquired`;
  
  if (acquired) {
    // proceed with migrations
    break;
  }
  
  if (attempt === maxRetries - 1) {
    return { schema, status: "skipped", applied: [] };
  }
  
  // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
  await sleep(baseDelayMs * Math.pow(2, attempt));
}
```

- Transaction-scoped lock (`pg_try_advisory_xact_lock`) auto-releases on commit/rollback
- Non-blocking with retries: gives transient contention a chance to resolve
- Returns `skipped` only after exhausting retries

## Test Utilities

```typescript
class TestDatabase {
  schema: string;      // random schema like "accounts_test_abc123"
  sql: SQL;            // connection to test database
  
  static async create(): Promise<TestDatabase>  // create random schema, run migrations
  async dispose(): Promise<void>                // drop schema, close connection
}
```

Enables test isolation - each test gets a clean, isolated schema.

## Migration File Format

**Naming:** `NNN_descriptive_name.sql` (zero-padded 3-digit prefix, snake_case)

**Import:** SQL files imported at build time:
```typescript
import migration001 from "./migrations/001_create_schema.sql" with { type: "text" };
```

**Template syntax:** `{{variable}}` for substitution. Initially just `{{schema}}`.

**Bootstrap migration (001_create_schema.sql):**
```sql
create schema if not exists {{schema}};
```

## Dependencies

- **Bun.SQL** - PostgreSQL driver (same as engine)
- No external migration frameworks

## Out of Scope

- Accounts schema design (users, sessions, orgs, billing tables)
- CLI commands for running migrations
- Bootstrap phase for extensions (accounts doesn't need pgvector/pg_textsearch)
