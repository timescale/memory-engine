import type { Sql as SQL } from "postgres";
import postgres from "postgres";
import { type MigrateCoreOptions, migrateCore } from "./migrate";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
//
// Tests run against a real Postgres that has the required extensions
// (citext, ltree, vector, pg_textsearch) and is PG 18+. Two ways to provide
// one:
//
//   - local docker (fast iteration): ./bun run pg   (then leave TEST_DATABASE_URL unset)
//   - ghost (real TigerData stack):  TEST_DATABASE_URL="$(ghost connect testing_me)"
//
// Because the core migrations are templated (production uses the "core"
// schema; tests pass a unique schema name), every test can provision its own
// throwaway core and run concurrently — exactly like space tests, and without
// ever touching a real `core` schema.

const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres@127.0.0.1:5432/postgres";

export function resolveTestDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export function connect(max = 10): SQL {
  // onnotice silences the routine "… already exists, skipping" NOTICEs that the
  // idempotent migrations emit (postgres-js prints them to the console by default).
  return postgres(resolveTestDatabaseUrl(), { max, onnotice: () => {} });
}

const SCHEMA_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A unique, valid core schema name, e.g. "core_test_a1b2c3d4". */
export function randomCoreSchema(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let suffix = "";
  for (const b of bytes) suffix += SCHEMA_SUFFIX_ALPHABET[b % 36];
  return `core_test_${suffix}`;
}

// ---------------------------------------------------------------------------
// TestCore — a provisioned, isolated core schema
// ---------------------------------------------------------------------------

export class TestCore {
  readonly schema: string;
  private readonly sql: SQL;

  private constructor(sql: SQL, schema: string) {
    this.sql = sql;
    this.schema = schema;
  }

  static async create(
    sql: SQL,
    options: Omit<MigrateCoreOptions, "schema"> & { schema?: string } = {},
  ): Promise<TestCore> {
    const schema = options.schema ?? randomCoreSchema();
    await migrateCore(sql, { ...options, schema });
    return new TestCore(sql, schema);
  }

  async drop(): Promise<void> {
    await this.sql.unsafe(`drop schema if exists ${this.schema} cascade`);
  }
}

/**
 * Provision a fresh core, run `fn` against it, and always drop it afterward.
 * Safe to call from concurrent tests — each gets its own unique schema.
 */
export async function withTestCore<T>(
  sql: SQL,
  options: Omit<MigrateCoreOptions, "schema"> & { schema?: string },
  fn: (core: TestCore) => Promise<T>,
): Promise<T> {
  const core = await TestCore.create(sql, options);
  try {
    return await fn(core);
  } finally {
    await core.drop();
  }
}

/**
 * Assert that a query rejects. bun:test's `expect(...).rejects` does not drive
 * postgres-js's lazy `PendingQuery` (it only runs when truly awaited), so it
 * hangs; awaiting inside try/catch executes the query and observes the error.
 */
export async function expectReject(fn: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("expected the operation to reject, but it resolved");
  }
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

export async function schemaExists(sql: SQL, name: string): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from information_schema.schemata where schema_name = ${name}
    ) as exists
  `;
  return Boolean(row?.exists);
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
  return Boolean(row?.exists);
}

export async function listTables(sql: SQL, schema: string): Promise<string[]> {
  const rows = await sql`
    select table_name
    from information_schema.tables
    where table_schema = ${schema} and table_type = 'BASE TABLE'
    order by table_name
  `;
  return rows.map((r) => r.table_name as string);
}

/** Distinct function names in a schema (overloads collapse to one entry). */
export async function listFunctions(
  sql: SQL,
  schema: string,
): Promise<string[]> {
  const rows = await sql`
    select distinct p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema}
    order by p.proname
  `;
  return rows.map((r) => r.proname as string);
}

export async function listTriggers(
  sql: SQL,
  schema: string,
  table: string,
): Promise<string[]> {
  const rows = await sql`
    select t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname = ${table} and not t.tgisinternal
    order by t.tgname
  `;
  return rows.map((r) => r.tgname as string);
}

/** Whether an extension is installed (in any schema). */
export async function extensionInstalled(
  sql: SQL,
  name: string,
): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from pg_extension where extname = ${name}
    ) as exists
  `;
  return Boolean(row?.exists);
}

export async function appliedMigrations(
  sql: SQL,
  schema: string,
): Promise<string[]> {
  const rows = await sql.unsafe(
    `select name from ${schema}.migration order by name`,
  );
  return rows.map((r) => r.name as string);
}

export async function getSchemaVersion(
  sql: SQL,
  schema: string,
): Promise<string> {
  const [row] = await sql.unsafe(`select version from ${schema}.version`);
  return row?.version;
}
