# Engine Migration Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add version tracking, lock retry with exponential backoff, and ownership checking to the engine migration system.

**Architecture:** Enhance `provisionEngine` to create version table atomically with schema, and enhance `migrateEngine` with defensive checks. Two separate transactions: provisioning (schema infrastructure) and migrations (schema changes).

**Tech Stack:** Bun, Bun.SQL, TypeScript

---

## File Structure

```
packages/engine/migrate/
├── provision.ts    # Modified: wrap in transaction, add version table, fail on existing schema
├── runner.ts       # Modified: add lock retry, ownership check, version check, getVersion()
├── index.ts        # Modified: export getVersion
└── migrate.integration.test.ts  # Modified: update tests for new behavior
```

---

### Task 1: Update provision.ts - Transactional Schema Creation

**Files:**
- Modify: `packages/engine/migrate/provision.ts`

- [ ] **Step 1: Rewrite provisionEngine with transaction and version table**

```typescript
import type { SQL } from "bun";

import { isValidSlug, slugToSchema } from "./discover";
import { type MigrateResult, migrateEngine } from "./runner";
import type { EngineConfig } from "./template";

export interface ProvisionResult {
  schema: string;
  migrateResult: MigrateResult;
}

export async function provisionEngine(
  sql: SQL,
  slug: string,
  config: EngineConfig | undefined,
  appVersion: string,
): Promise<ProvisionResult> {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid engine slug: "${slug}" — must be 12 lowercase alphanumeric characters`,
    );
  }

  const schema = slugToSchema(slug);

  // Transaction 1: Create schema infrastructure (all or nothing)
  await sql.begin(async (tx) => {
    // Create schema (fails if exists - use migrateEngine for existing schemas)
    await tx.unsafe(`create schema ${schema}`);

    // Version tracking table (single row)
    await tx.unsafe(`
      create table ${schema}.version
      ( version text not null check (version ~ '^\\d+\\.\\d+\\.\\d+$')
      , at timestamptz not null default now()
      )
    `);
    await tx.unsafe(`create unique index on ${schema}.version ((true))`);
    await tx.unsafe(
      `insert into ${schema}.version (version) values ('0.0.0')`,
    );

    // Grant usage to all roles
    await tx.unsafe(
      `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
    );
  });

  // Transaction 2: Run migrations
  const migrateResult = await migrateEngine(sql, schema, config, appVersion);

  return { schema, migrateResult };
}
```

Write to `packages/engine/migrate/provision.ts`.

- [ ] **Step 2: Commit**

```bash
git add packages/engine/migrate/provision.ts
git commit -m "feat(engine): make provisionEngine transactional with version table"
```

---

### Task 2: Update runner.ts - Add Lock Retry, Ownership Check, Version Check

**Files:**
- Modify: `packages/engine/migrate/runner.ts`

- [ ] **Step 1: Add semver import and constants**

Add at top of file after existing imports:

```typescript
import { type SQL, semver } from "bun";
```

(Change existing `import type { SQL } from "bun";` to include semver)

Add after imports:

```typescript
const MAX_LOCK_RETRIES = 5;
const BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Add ownership check helper**

Add before `migrateEngine` function:

```typescript
async function assertSchemaOwnership(tx: SQL, schema: string): Promise<void> {
  const [result] = await tx`
    select
      n.nspowner = (select pg_catalog.to_regrole(current_user)::oid) as is_owner
    from pg_catalog.pg_namespace n
    where n.nspname = ${schema}
  `;

  if (!result?.is_owner) {
    throw new Error(
      `Only the owner of the ${schema} schema can run database migrations`,
    );
  }
}
```

- [ ] **Step 3: Rewrite migrateEngine with all enhancements**

Replace the entire `migrateEngine` function:

```typescript
export async function migrateEngine(
  sql: SQL,
  schema: string,
  config: EngineConfig | undefined,
  appVersion: string,
): Promise<MigrateResult> {
  await assertEngineSchema(sql, schema);
  const resolved = resolveConfig(schema, config);

  return await sql.begin(async (tx) => {
    // 1. Acquire advisory lock with retry
    const [{ lock_id }] = await tx`
      select hashtext(${schema})::bigint as lock_id
    `;

    let acquired = false;
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const [result] = await tx`
        select pg_try_advisory_xact_lock(${lock_id}) as acquired
      `;
      if (result.acquired) {
        acquired = true;
        break;
      }
      if (attempt < MAX_LOCK_RETRIES - 1) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
      }
    }

    if (!acquired) {
      return { schema, status: "skipped" as const, applied: [] };
    }

    // 2. Check ownership
    await assertSchemaOwnership(tx, schema);

    // 3. Check version (reject downgrades)
    const [{ version: dbVersion }] = await tx.unsafe(
      `select version from ${schema}.version`,
    );

    const cmp = semver.order(appVersion, dbVersion);
    if (cmp < 0) {
      throw new Error(
        `App version (${appVersion}) is older than database version (${dbVersion}). ` +
          "Please upgrade the application.",
      );
    }

    // 4. Scaffold migration tracking table
    await tx.unsafe(`
      create table if not exists ${schema}.migration
      ( name text not null primary key
      , applied_at_version text not null
      , applied_at timestamptz not null default pg_catalog.clock_timestamp()
      )
    `);

    // 5. Run migrations
    const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
    const applied: string[] = [];

    for (const migration of sorted) {
      const [existing] = await tx.unsafe(
        `select 1 from ${schema}.migration where name = $1`,
        [migration.name],
      );

      if (existing) {
        continue;
      }

      const renderedSql = template(migration.sql, resolved);
      await tx.unsafe(renderedSql);
      await tx.unsafe(
        `insert into ${schema}.migration (name, applied_at_version) values ($1, $2)`,
        [migration.name, appVersion],
      );
      applied.push(migration.name);
    }

    // 6. Update version if app version is newer
    if (cmp > 0) {
      await tx.unsafe(
        `update ${schema}.version set version = $1, at = now()`,
        [appVersion],
      );
    }

    return { schema, status: "ok" as const, applied };
  });
}
```

- [ ] **Step 4: Add getVersion function**

Add after `getMigrations` function:

```typescript
export async function getVersion(sql: SQL, schema: string): Promise<string> {
  await assertEngineSchema(sql, schema);
  const [row] = await sql.unsafe(`select version from ${schema}.version`);
  return row.version;
}
```

- [ ] **Step 5: Run unit tests**

```bash
bun test packages/engine/migrate/runner.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/migrate/runner.ts
git commit -m "feat(engine): add lock retry, ownership check, and version tracking to migrateEngine"
```

---

### Task 3: Update index.ts - Export getVersion

**Files:**
- Modify: `packages/engine/migrate/index.ts`

- [ ] **Step 1: Add getVersion to exports**

Change line 13 from:
```typescript
export { dryRun, getMigrations, migrateAll, migrateEngine } from "./runner";
```

To:
```typescript
export { dryRun, getMigrations, getVersion, migrateAll, migrateEngine } from "./runner";
```

- [ ] **Step 2: Commit**

```bash
git add packages/engine/migrate/index.ts
git commit -m "feat(engine): export getVersion from migrate module"
```

---

### Task 4: Update Integration Tests

**Files:**
- Modify: `packages/engine/migrate/migrate.integration.test.ts`

- [ ] **Step 1: Add getVersion import**

Update the import from `./runner` to include `getVersion`:

```typescript
import { dryRun, getMigrations, getVersion, migrateAll, migrateEngine } from "./runner";
```

- [ ] **Step 2: Update provisioning idempotency test**

Find and replace the "is idempotent" test in the provisioning describe block:

```typescript
  test("fails if schema already exists", async () => {
    const slug = "prov00000002";
    await provisionEngine(sql, slug, undefined, "0.1.0");

    await expect(
      provisionEngine(sql, slug, undefined, "0.1.0"),
    ).rejects.toThrow();
  });
```

- [ ] **Step 3: Add version tracking tests**

Add a new describe block for version tracking:

```typescript
describe("version tracking", () => {
  test("rejects downgrade", async () => {
    const slug = "version00001";
    const schema = `me_${slug}`;
    testSchemas.push(schema);

    await provisionEngine(sql, slug, undefined, "0.2.0");

    await expect(
      migrateEngine(sql, schema, undefined, "0.1.0"),
    ).rejects.toThrow("older than database version");
  });

  test("updates version on upgrade", async () => {
    const slug = "version00002";
    const schema = `me_${slug}`;
    testSchemas.push(schema);

    await provisionEngine(sql, slug, undefined, "0.1.0");
    expect(await getVersion(sql, schema)).toBe("0.1.0");

    await migrateEngine(sql, schema, undefined, "0.2.0");
    expect(await getVersion(sql, schema)).toBe("0.2.0");
  });

  test("getVersion returns current version", async () => {
    const slug = "version00003";
    const schema = `me_${slug}`;
    testSchemas.push(schema);

    await provisionEngine(sql, slug, undefined, "1.2.3");
    expect(await getVersion(sql, schema)).toBe("1.2.3");
  });

  test("same version is no-op for version table", async () => {
    const slug = "version00004";
    const schema = `me_${slug}`;
    testSchemas.push(schema);

    await provisionEngine(sql, slug, undefined, "0.1.0");
    const result = await migrateEngine(sql, schema, undefined, "0.1.0");

    expect(result.status).toBe("ok");
    expect(await getVersion(sql, schema)).toBe("0.1.0");
  });
});
```

- [ ] **Step 4: Run integration tests**

```bash
bun test packages/engine/migrate/migrate.integration.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/migrate/migrate.integration.test.ts
git commit -m "test(engine): update tests for version tracking and non-idempotent provisioning"
```

---

### Task 5: Run Full Test Suite and Verify

**Files:**
- None (verification only)

- [ ] **Step 1: Run all engine tests**

```bash
bun test packages/engine
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
bun run format:fix && bun run lint:fix
git add -A
git commit -m "fix(engine): address linting/formatting issues"
```
