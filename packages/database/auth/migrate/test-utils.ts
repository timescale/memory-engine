import type { Sql as SQL } from "postgres";
import { type MigrateAuthOptions, migrateAuth } from "./migrate";

// Connection, failure assertions, and schema introspection are shared with the
// core and space suites.
export * from "../../migrate/test-utils";

const SCHEMA_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A unique, valid auth schema name, e.g. "auth_test_a1b2c3d4". */
export function randomAuthSchema(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let suffix = "";
  for (const b of bytes) suffix += SCHEMA_SUFFIX_ALPHABET[b % 36];
  return `auth_test_${suffix}`;
}

// ---------------------------------------------------------------------------
// TestAuth — a provisioned, isolated auth schema
// ---------------------------------------------------------------------------
//
// The auth migrations are templated (production uses the "auth" schema; tests
// pass a unique throwaway name), so every test gets its own isolated auth schema
// and they run concurrently without ever touching a real `auth` schema.

export class TestAuth {
  readonly schema: string;
  private readonly sql: SQL;

  private constructor(sql: SQL, schema: string) {
    this.sql = sql;
    this.schema = schema;
  }

  static async create(
    sql: SQL,
    options: Omit<MigrateAuthOptions, "schema"> & { schema?: string } = {},
  ): Promise<TestAuth> {
    const schema = options.schema ?? randomAuthSchema();
    await migrateAuth(sql, { ...options, schema });
    return new TestAuth(sql, schema);
  }

  async drop(): Promise<void> {
    await this.sql.unsafe(`drop schema if exists ${this.schema} cascade`);
  }
}

/**
 * Provision a fresh auth schema, run `fn` against it, and always drop it
 * afterward. Safe to call from concurrent tests — each gets its own unique
 * schema.
 */
export async function withTestAuth<T>(
  sql: SQL,
  options: Omit<MigrateAuthOptions, "schema"> & { schema?: string },
  fn: (auth: TestAuth) => Promise<T>,
): Promise<T> {
  const auth = await TestAuth.create(sql, options);
  try {
    return await fn(auth);
  } finally {
    await auth.drop();
  }
}
