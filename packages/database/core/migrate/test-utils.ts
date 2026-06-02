import type { Sql as SQL } from "postgres";
import { type MigrateCoreOptions, migrateCore } from "./migrate";

// Connection, failure assertions, and schema introspection are shared with the
// space suite.
export * from "../../migrate/test-utils";

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
//
// The core migrations are templated (production uses the "core" schema; tests
// pass a unique throwaway name), so every test gets its own isolated core and
// they run concurrently without ever touching a real `core` schema.

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
