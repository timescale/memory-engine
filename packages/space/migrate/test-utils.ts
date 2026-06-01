import type { Sql as SQL } from "postgres";
import postgres from "postgres";
import { type MigrateSpaceOptions, migrateSpace } from "./migrate";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
//
// See packages/core/migrate/test-utils.ts for the connection model. In short:
// provide a PG 18+ database with citext/ltree/vector/pg_textsearch via
// TEST_DATABASE_URL (ghost) or fall back to local docker Postgres.
//
// Spaces isolate cleanly: each space is its own `me_<slug>` schema, so many
// can coexist in one database and tests can run concurrently with unique
// slugs — no `create database` needed (ghost forbids it anyway).

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

/**
 * Test spaces provision under a `metest_<slug>` schema instead of the production
 * `me_<slug>`, so leftover test schemas are distinguishable from real spaces by
 * name alone: scripts/clean-test-schemas.ts sweeps `metest_*` (and
 * `core_test_*`) and can never touch a production `me_*` space. `metest_`
 * deliberately does not start with the `me_` engine-schema prefix.
 */
const TEST_SCHEMA_PREFIX = "metest_";

/** The throwaway schema name a test space provisions under (`metest_<slug>`). */
export function testSchema(slug: string): string {
  return `${TEST_SCHEMA_PREFIX}${slug}`;
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random valid space slug: 12 lowercase alphanumeric chars. */
export function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let slug = "";
  for (const b of bytes) slug += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return slug;
}

// ---------------------------------------------------------------------------
// TestSpace — a provisioned, isolated space schema
// ---------------------------------------------------------------------------

/**
 * A migrated space schema in the shared test database. Assumes
 * bootstrapSpaceDatabase() has already run (extensions installed) — do that
 * once per file in beforeAll.
 */
export class TestSpace {
  readonly slug: string;
  readonly schema: string;
  private readonly sql: SQL;

  private constructor(sql: SQL, slug: string) {
    this.sql = sql;
    this.slug = slug;
    this.schema = testSchema(slug);
  }

  static async create(
    sql: SQL,
    options: Omit<MigrateSpaceOptions, "slug" | "schema"> & {
      slug?: string;
    } = {},
  ): Promise<TestSpace> {
    const slug = options.slug ?? randomSlug();
    // Provision under metest_<slug> so leftovers are name-distinguishable from
    // production me_<slug> spaces (see clean-test-schemas.ts).
    await migrateSpace(sql, { ...options, slug, schema: testSchema(slug) });
    return new TestSpace(sql, slug);
  }

  async drop(): Promise<void> {
    await this.sql.unsafe(`drop schema if exists ${this.schema} cascade`);
  }
}

/**
 * Provision a fresh space, run `fn` against it, and always drop it afterward.
 * Safe to call from concurrent tests — each gets its own unique schema.
 */
export async function withTestSpace<T>(
  sql: SQL,
  options: Omit<MigrateSpaceOptions, "slug"> & { slug?: string },
  fn: (space: TestSpace) => Promise<T>,
): Promise<T> {
  const space = await TestSpace.create(sql, options);
  try {
    return await fn(space);
  } finally {
    await space.drop();
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
// Schema introspection (mirrors packages/core/migrate/test-utils.ts; kept
// local so the package stays self-contained)
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

/** Fully-resolved type of a column, e.g. "halfvec(768)" or "uuid". */
export async function columnType(
  sql: SQL,
  schema: string,
  table: string,
  column: string,
): Promise<string | null> {
  const [row] = await sql`
    select format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
    where a.attrelid = ${`${schema}.${table}`}::regclass
      and a.attname = ${column}
      and not a.attisdropped
  `;
  return row?.type ?? null;
}

export async function listIndexes(
  sql: SQL,
  schema: string,
  table: string,
): Promise<string[]> {
  const rows = await sql`
    select indexname from pg_indexes
    where schemaname = ${schema} and tablename = ${table}
    order by indexname
  `;
  return rows.map((r) => r.indexname as string);
}

export async function getIndexDef(
  sql: SQL,
  schema: string,
  index: string,
): Promise<string | null> {
  const [row] = await sql`
    select indexdef from pg_indexes
    where schemaname = ${schema} and indexname = ${index}
  `;
  return row?.indexdef ?? null;
}

/** Storage parameters of an index, e.g. ["m=8", "ef_construction=32"]. */
export async function getIndexReloptions(
  sql: SQL,
  schema: string,
  index: string,
): Promise<string[]> {
  const [row] = await sql`
    select c.reloptions
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname = ${index}
  `;
  return row?.reloptions ?? [];
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
