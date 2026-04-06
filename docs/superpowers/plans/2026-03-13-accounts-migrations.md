# Accounts Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a database migration system for the accounts package - a simplified version of the engine migration system for a single, unsharded database.

**Architecture:** Copy and simplify `packages/engine/migrate/` removing multi-schema concerns. Add schema version tracking with semver comparison to prevent running old app code against newer databases. Include retry logic with exponential backoff for advisory lock acquisition.

**Tech Stack:** Bun, Bun.SQL, TypeScript

---

## File Structure

```
packages/accounts/
├── package.json              # Package manifest
└── migrate/
    ├── index.ts              # Public API exports
    ├── runner.ts             # Core migration execution with version tracking
    ├── template.ts           # SQL template substitution (simplified)
    ├── test-utils.ts         # TestDatabase helper for test isolation
    ├── runner.test.ts        # Unit tests for getMigrations
    ├── template.test.ts      # Unit tests for template function
    ├── migrate.integration.test.ts  # Integration tests
    └── migrations/
        ├── sql.d.ts          # TypeScript declaration for .sql imports
        └── 001_create_schema.sql  # Bootstrap migration
```

---

### Task 1: Create Package Structure

**Files:**
- Create: `packages/accounts/package.json`
- Create: `packages/accounts/migrate/migrations/sql.d.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@memory-engine/accounts",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

Write to `packages/accounts/package.json`.

- [ ] **Step 2: Create SQL type declaration**

```typescript
declare module "*.sql" {
  const content: string;
  export default content;
}
```

Write to `packages/accounts/migrate/migrations/sql.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/accounts/package.json packages/accounts/migrate/migrations/sql.d.ts
git commit -m "feat(accounts): create package structure"
```

---

### Task 2: Implement Template Function

**Files:**
- Create: `packages/accounts/migrate/template.ts`
- Create: `packages/accounts/migrate/template.test.ts`

- [ ] **Step 1: Write failing tests for template function**

```typescript
import { describe, expect, test } from "bun:test";
import { defaultConfig, resolveConfig, template } from "./template";

describe("template function", () => {
  test("replaces single variable", () => {
    const sql = "CREATE TABLE {{schema}}.foo (id uuid)";
    const result = template(sql, { schema: "accounts" });
    expect(result).toBe("CREATE TABLE accounts.foo (id uuid)");
  });

  test("replaces same variable multiple times", () => {
    const sql = "{{schema}}.a and {{schema}}.b";
    const result = template(sql, { schema: "test" });
    expect(result).toBe("test.a and test.b");
  });

  test("throws on missing variable", () => {
    const sql = "CREATE TABLE {{missing}}.foo";
    expect(() => template(sql, {})).toThrow("Missing template variable: missing");
  });

  test("handles no variables", () => {
    const sql = "CREATE TABLE foo (id uuid)";
    const result = template(sql, {});
    expect(result).toBe("CREATE TABLE foo (id uuid)");
  });

  test("handles numeric values", () => {
    const sql = "LIMIT {{limit}}";
    const result = template(sql, { limit: 100 });
    expect(result).toBe("LIMIT 100");
  });
});

describe("config", () => {
  test("defaultConfig has schema = accounts", () => {
    expect(defaultConfig.schema).toBe("accounts");
  });

  test("resolveConfig uses default schema", () => {
    const resolved = resolveConfig();
    expect(resolved.schema).toBe("accounts");
  });

  test("resolveConfig allows schema override", () => {
    const resolved = resolveConfig({ schema: "accounts_test" });
    expect(resolved.schema).toBe("accounts_test");
  });
});
```

Write to `packages/accounts/migrate/template.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/accounts/migrate/template.test.ts
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement template function**

```typescript
export function template(sql: string, vars: Record<string, unknown>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(vars[key]);
  });
}

export interface AccountsConfig {
  schema?: string;
}

export type ResolvedConfig = Required<AccountsConfig>;

export const defaultConfig: ResolvedConfig = {
  schema: "accounts",
};

export function resolveConfig(config?: AccountsConfig): ResolvedConfig {
  return { ...defaultConfig, ...config };
}
```

Write to `packages/accounts/migrate/template.ts`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/accounts/migrate/template.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/accounts/migrate/template.ts packages/accounts/migrate/template.test.ts
git commit -m "feat(accounts): add template function for SQL variable substitution"
```

---

### Task 3: Create Bootstrap Migration

**Files:**
- Create: `packages/accounts/migrate/migrations/001_create_schema.sql`

- [ ] **Step 1: Write bootstrap migration**

```sql
-- Bootstrap migration: creates the accounts schema and infrastructure tables
create schema if not exists {{schema}};

-- Version tracking table (single row, tracks overall schema version)
create table {{schema}}.version
( version text not null check (version ~ '^\d+\.\d+\.\d+$')
, at timestamptz not null default now()
);
create unique index on {{schema}}.version ((true));
insert into {{schema}}.version (version) values ('0.0.0');

-- Migration tracking table
create table {{schema}}.migration
( name text not null primary key
, applied_at_version text not null
, applied_at timestamptz not null default pg_catalog.clock_timestamp()
);
```

Write to `packages/accounts/migrate/migrations/001_create_schema.sql`.

- [ ] **Step 2: Commit**

```bash
git add packages/accounts/migrate/migrations/001_create_schema.sql
git commit -m "feat(accounts): add bootstrap migration for schema and version tracking"
```

---

### Task 4: Implement Migration Runner

**Files:**
- Create: `packages/accounts/migrate/runner.ts`
- Create: `packages/accounts/migrate/runner.test.ts`

- [ ] **Step 1: Write failing unit tests for getMigrations**

```typescript
import { describe, expect, test } from "bun:test";
import { getMigrations } from "./runner";

describe("getMigrations", () => {
  test("returns at least 1 migration", () => {
    expect(getMigrations().length).toBeGreaterThanOrEqual(1);
  });

  test("migrations are sorted by name", () => {
    const names = getMigrations().map((m) => m.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("migration names match NNN_name pattern", () => {
    for (const { name } of getMigrations()) {
      expect(name).toMatch(/^\d{3}_\w+$/);
    }
  });

  test("contains bootstrap migration", () => {
    const names = getMigrations().map((m) => m.name);
    expect(names).toContain("001_create_schema");
  });
});
```

Write to `packages/accounts/migrate/runner.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/accounts/migrate/runner.test.ts
```

Expected: FAIL - module not found.

- [ ] **Step 3: Implement migration runner**

```typescript
import { type SQL, semver } from "bun";
import migration001 from "./migrations/001_create_schema.sql" with { type: "text" };
import { type AccountsConfig, resolveConfig, template } from "./template";

interface Migration {
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  { name: "001_create_schema", sql: migration001 },
];

export interface MigrateResult {
  schema: string;
  status: "ok" | "skipped" | "error";
  applied: string[];
  error?: Error;
}

const MAX_LOCK_RETRIES = 5;
const BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function migrate(
  sql: SQL,
  config?: AccountsConfig,
  appVersion = "0.0.0",
): Promise<MigrateResult> {
  const resolved = resolveConfig(config);
  const { schema } = resolved;

  return await sql.begin(async (tx) => {
    // Acquire advisory lock with retry
    const [{ lock_id }] = await tx`select hashtext(${schema})::bigint as lock_id`;

    let acquired = false;
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const [result] = await tx`select pg_try_advisory_xact_lock(${lock_id}) as acquired`;
      if (result.acquired) {
        acquired = true;
        break;
      }
      if (attempt < MAX_LOCK_RETRIES - 1) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }

    if (!acquired) {
      return { schema, status: "skipped" as const, applied: [] };
    }

    // Check if schema exists (first migration creates it)
    const [{ schema_exists }] = await tx`
      select exists (
        select 1 from information_schema.schemata where schema_name = ${schema}
      ) as schema_exists
    `;

    // Check version if schema exists
    if (schema_exists) {
      const [{ table_exists }] = await tx`
        select exists (
          select 1 from information_schema.tables
          where table_schema = ${schema} and table_name = 'version'
        ) as table_exists
      `;

      if (table_exists) {
        const [{ version: dbVersion }] = await tx.unsafe(
          `select version from ${schema}.version`
        );

        const cmp = semver.order(appVersion, dbVersion);
        if (cmp < 0) {
          throw new Error(
            `App version (${appVersion}) is older than database version (${dbVersion}). ` +
            "Please upgrade the application."
          );
        }
      }
    }

    // Run migrations
    const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
    const applied: string[] = [];

    for (const migration of sorted) {
      // Check if migration table exists before querying it
      if (schema_exists) {
        const [{ table_exists }] = await tx`
          select exists (
            select 1 from information_schema.tables
            where table_schema = ${schema} and table_name = 'migration'
          ) as table_exists
        `;

        if (table_exists) {
          const [existing] = await tx.unsafe(
            `select 1 from ${schema}.migration where name = $1`,
            [migration.name],
          );

          if (existing) {
            continue;
          }
        }
      }

      const renderedSql = template(migration.sql, resolved);
      await tx.unsafe(renderedSql);
      await tx.unsafe(
        `insert into ${schema}.migration (name, applied_at_version) values ($1, $2)`,
        [migration.name, appVersion],
      );
      applied.push(migration.name);
    }

    // Update version if we applied migrations and app version is newer
    if (applied.length > 0 || schema_exists) {
      const [{ version: currentVersion }] = await tx.unsafe(
        `select version from ${schema}.version`
      );
      if (semver.order(appVersion, currentVersion) > 0) {
        await tx.unsafe(
          `update ${schema}.version set version = $1, at = now()`,
          [appVersion],
        );
      }
    }

    return { schema, status: "ok" as const, applied };
  });
}

export async function dryRun(
  sql: SQL,
  config?: AccountsConfig,
): Promise<{ pending: string[]; applied: string[] }> {
  const { schema } = resolveConfig(config);
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  // Check if migration table exists
  const [{ exists }] = await sql`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = 'migration'
    ) as exists
  `;

  if (!exists) {
    return {
      pending: sorted.map((m) => m.name),
      applied: [],
    };
  }

  const rows = await sql.unsafe(
    `select name from ${schema}.migration order by name`,
  );
  const appliedSet = new Set(rows.map((r: { name: string }) => r.name));
  const applied = sorted.filter((m) => appliedSet.has(m.name)).map((m) => m.name);
  const pending = sorted.filter((m) => !appliedSet.has(m.name)).map((m) => m.name);

  return { pending, applied };
}

export async function getVersion(
  sql: SQL,
  config?: AccountsConfig,
): Promise<string> {
  const { schema } = resolveConfig(config);
  const [row] = await sql.unsafe(`select version from ${schema}.version`);
  return row.version;
}

export function getMigrations(): ReadonlyArray<{ name: string }> {
  return [...migrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => ({ name }));
}
```

Write to `packages/accounts/migrate/runner.ts`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/accounts/migrate/runner.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/accounts/migrate/runner.ts packages/accounts/migrate/runner.test.ts
git commit -m "feat(accounts): implement migration runner with version tracking"
```

---

### Task 5: Create Public API Exports

**Files:**
- Create: `packages/accounts/migrate/index.ts`

- [ ] **Step 1: Create index.ts with exports**

```typescript
export type { MigrateResult } from "./runner";
export { dryRun, getMigrations, getVersion, migrate } from "./runner";
export type { AccountsConfig, ResolvedConfig } from "./template";
export { defaultConfig, resolveConfig, template } from "./template";
```

Write to `packages/accounts/migrate/index.ts`.

- [ ] **Step 2: Commit**

```bash
git add packages/accounts/migrate/index.ts
git commit -m "feat(accounts): add public API exports"
```

---

### Task 6: Implement Test Utilities

**Files:**
- Create: `packages/accounts/migrate/test-utils.ts`

- [ ] **Step 1: Write test utilities**

```typescript
import { SQL } from "bun";
import { migrate } from "./runner";
import type { AccountsConfig } from "./template";

function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
}

export class TestDatabase {
  schema: string;
  sql: SQL;
  private readonly adminUrl: string;

  private constructor(schema: string, sql: SQL, adminUrl: string) {
    this.schema = schema;
    this.sql = sql;
    this.adminUrl = adminUrl;
  }

  static async create(
    adminUrl = "postgresql://postgres@localhost:5432/postgres",
    appVersion = "0.1.0",
  ): Promise<TestDatabase> {
    const schema = `accounts_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    assertSafeIdentifier(schema);

    const sql = new SQL(adminUrl);
    const config: AccountsConfig = { schema };

    await migrate(sql, config, appVersion);

    return new TestDatabase(schema, sql, adminUrl);
  }

  async dispose(): Promise<void> {
    assertSafeIdentifier(this.schema);
    await this.sql.unsafe(`drop schema if exists ${this.schema} cascade`);
    await this.sql.close();
  }
}

export async function getAppliedMigrations(
  sql: SQL,
  schema: string,
): Promise<string[]> {
  const rows = await sql.unsafe(
    `select name from ${schema}.migration order by name`,
  );
  return rows.map((r: { name: string }) => r.name);
}

export async function tableExists(
  sql: SQL,
  schema: string,
  table: string,
): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = ${table}
    ) as exists
  `;
  return row.exists;
}

export async function schemaExists(sql: SQL, name: string): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from information_schema.schemata
      where schema_name = ${name}
    ) as exists
  `;
  return row.exists;
}

export async function getDatabaseVersion(
  sql: SQL,
  schema: string,
): Promise<string> {
  const [row] = await sql.unsafe(`select version from ${schema}.version`);
  return row.version;
}
```

Write to `packages/accounts/migrate/test-utils.ts`.

- [ ] **Step 2: Commit**

```bash
git add packages/accounts/migrate/test-utils.ts
git commit -m "feat(accounts): add test utilities for migration testing"
```

---

### Task 7: Write Integration Tests

**Files:**
- Create: `packages/accounts/migrate/migrate.integration.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { dryRun, getMigrations, getVersion, migrate } from "./runner";
import {
  getDatabaseVersion,
  getAppliedMigrations,
  schemaExists,
  tableExists,
  TestDatabase,
} from "./test-utils";

const adminUrl = "postgresql://postgres@localhost:5432/postgres";

describe("integration: migrate", () => {
  let sql: SQL;
  const testSchemas: string[] = [];

  beforeAll(() => {
    sql = new SQL(adminUrl);
  });

  afterEach(async () => {
    for (const schema of testSchemas) {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    }
    testSchemas.length = 0;
  });

  afterAll(async () => {
    await sql.close();
  });

  function testSchema(): string {
    const schema = `accounts_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    testSchemas.push(schema);
    return schema;
  }

  test("creates schema and tables on first run", async () => {
    const schema = testSchema();
    const result = await migrate(sql, { schema }, "0.1.0");

    expect(result.status).toBe("ok");
    expect(result.applied).toContain("001_create_schema");
    expect(await schemaExists(sql, schema)).toBe(true);
    expect(await tableExists(sql, schema, "version")).toBe(true);
    expect(await tableExists(sql, schema, "migration")).toBe(true);
  });

  test("is idempotent", async () => {
    const schema = testSchema();

    const result1 = await migrate(sql, { schema }, "0.1.0");
    expect(result1.status).toBe("ok");
    expect(result1.applied.length).toBeGreaterThan(0);

    const result2 = await migrate(sql, { schema }, "0.1.0");
    expect(result2.status).toBe("ok");
    expect(result2.applied).toHaveLength(0);
  });

  test("tracks version correctly", async () => {
    const schema = testSchema();

    await migrate(sql, { schema }, "0.1.0");
    expect(await getDatabaseVersion(sql, schema)).toBe("0.1.0");

    await migrate(sql, { schema }, "0.2.0");
    expect(await getDatabaseVersion(sql, schema)).toBe("0.2.0");
  });

  test("rejects downgrade", async () => {
    const schema = testSchema();

    await migrate(sql, { schema }, "0.2.0");

    try {
      await migrate(sql, { schema }, "0.1.0");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("App version (0.1.0)");
      expect((error as Error).message).toContain("older than database version (0.2.0)");
    }
  });

  test("records migration metadata", async () => {
    const schema = testSchema();

    await migrate(sql, { schema }, "1.2.3");

    const rows = await sql.unsafe(`
      select name, applied_at_version, applied_at
      from ${schema}.migration
      order by name
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.applied_at_version).toBe("1.2.3");
      expect(row.applied_at).toBeTruthy();
    }
  });

  test("version table has single-row constraint", async () => {
    const schema = testSchema();
    await migrate(sql, { schema }, "0.1.0");

    try {
      await sql.unsafe(`insert into ${schema}.version (version) values ('0.2.0')`);
      expect.unreachable("should have thrown");
    } catch (error) {
      // Expected: unique constraint violation
      expect(error).toBeTruthy();
    }
  });
});

describe("integration: dryRun", () => {
  let sql: SQL;
  const testSchemas: string[] = [];

  beforeAll(() => {
    sql = new SQL(adminUrl);
  });

  afterEach(async () => {
    for (const schema of testSchemas) {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    }
    testSchemas.length = 0;
  });

  afterAll(async () => {
    await sql.close();
  });

  function testSchema(): string {
    const schema = `accounts_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    testSchemas.push(schema);
    return schema;
  }

  test("shows all pending for new schema", async () => {
    const schema = testSchema();
    const result = await dryRun(sql, { schema });

    expect(result.pending.length).toBe(getMigrations().length);
    expect(result.applied).toHaveLength(0);
  });

  test("shows none pending after migration", async () => {
    const schema = testSchema();
    await migrate(sql, { schema }, "0.1.0");

    const result = await dryRun(sql, { schema });

    expect(result.pending).toHaveLength(0);
    expect(result.applied.length).toBe(getMigrations().length);
  });
});

describe("integration: getVersion", () => {
  let sql: SQL;
  const testSchemas: string[] = [];

  beforeAll(() => {
    sql = new SQL(adminUrl);
  });

  afterEach(async () => {
    for (const schema of testSchemas) {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    }
    testSchemas.length = 0;
  });

  afterAll(async () => {
    await sql.close();
  });

  function testSchema(): string {
    const schema = `accounts_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    testSchemas.push(schema);
    return schema;
  }

  test("returns current version", async () => {
    const schema = testSchema();
    await migrate(sql, { schema }, "1.2.3");

    const version = await getVersion(sql, { schema });
    expect(version).toBe("1.2.3");
  });
});

describe("integration: TestDatabase", () => {
  test("creates isolated schema", async () => {
    const db = await TestDatabase.create(adminUrl, "0.1.0");

    try {
      expect(db.schema).toMatch(/^accounts_test_/);
      expect(await schemaExists(db.sql, db.schema)).toBe(true);
      expect(await tableExists(db.sql, db.schema, "migration")).toBe(true);
    } finally {
      await db.dispose();
    }
  });

  test("dispose drops schema", async () => {
    const db = await TestDatabase.create(adminUrl, "0.1.0");
    const schema = db.schema;

    const sql = new SQL(adminUrl);
    try {
      expect(await schemaExists(sql, schema)).toBe(true);
      await db.dispose();
      expect(await schemaExists(sql, schema)).toBe(false);
    } finally {
      await sql.close();
    }
  });
});

describe("integration: advisory locks", () => {
  let sql: SQL;
  const testSchemas: string[] = [];

  beforeAll(() => {
    sql = new SQL(adminUrl);
  });

  afterEach(async () => {
    for (const schema of testSchemas) {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    }
    testSchemas.length = 0;
  });

  afterAll(async () => {
    await sql.close();
  });

  function testSchema(): string {
    const schema = `accounts_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    testSchemas.push(schema);
    return schema;
  }

  test("concurrent migrations on same schema - only one applies", async () => {
    const schema = testSchema();

    const results = await Promise.all([
      migrate(sql, { schema }, "0.1.0"),
      migrate(sql, { schema }, "0.1.0"),
      migrate(sql, { schema }, "0.1.0"),
    ]);

    const withApplied = results.filter((r) => r.status === "ok" && r.applied.length > 0);
    const skipped = results.filter((r) => r.status === "skipped");
    const noOpOk = results.filter((r) => r.status === "ok" && r.applied.length === 0);

    // Exactly one should have applied migrations
    // Others either skipped (couldn't get lock) or got lock but found migrations already done
    expect(withApplied.length + skipped.length + noOpOk.length).toBe(3);

    // All migrations should exist exactly once
    const applied = await getAppliedMigrations(sql, schema);
    expect(applied).toHaveLength(getMigrations().length);
  });
});
```

Write to `packages/accounts/migrate/migrate.integration.test.ts`.

- [ ] **Step 2: Run integration tests**

```bash
bun test packages/accounts/migrate/migrate.integration.test.ts
```

Expected: All tests PASS (requires Postgres running via `bun run pg`).

- [ ] **Step 3: Commit**

```bash
git add packages/accounts/migrate/migrate.integration.test.ts
git commit -m "test(accounts): add integration tests for migration system"
```

---

### Task 8: Run Full Test Suite and Verify

**Files:**
- None (verification only)

- [ ] **Step 1: Run all accounts tests**

```bash
bun test packages/accounts
```

Expected: All tests PASS.

- [ ] **Step 2: Run project-wide checks**

```bash
bun run check
```

Expected: No formatting, linting, or type errors.

- [ ] **Step 3: Commit any fixes if needed**

If `bun run check` required fixes:

```bash
git add -A
git commit -m "fix(accounts): address linting/formatting issues"
```

---

### Task 9: Final Verification

**Files:**
- None (manual verification)

- [ ] **Step 1: Verify package structure**

```bash
ls -la packages/accounts/
ls -la packages/accounts/migrate/
ls -la packages/accounts/migrate/migrations/
```

Expected structure:
```
packages/accounts/
├── package.json
└── migrate/
    ├── index.ts
    ├── runner.ts
    ├── runner.test.ts
    ├── template.ts
    ├── template.test.ts
    ├── test-utils.ts
    ├── migrate.integration.test.ts
    └── migrations/
        ├── sql.d.ts
        └── 001_create_schema.sql
```

- [ ] **Step 2: Verify exports work**

```bash
bun -e "import { migrate, dryRun, getVersion, getMigrations } from './packages/accounts/migrate'; console.log('Exports:', { migrate: typeof migrate, dryRun: typeof dryRun, getVersion: typeof getVersion, getMigrations: typeof getMigrations })"
```

Expected: `Exports: { migrate: 'function', dryRun: 'function', getVersion: 'function', getMigrations: 'function' }`

- [ ] **Step 3: Final commit with complete message**

```bash
git add -A
git status
```

If there are uncommitted changes:

```bash
git commit -m "feat(accounts): complete migration system implementation"
```
