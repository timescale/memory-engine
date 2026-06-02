import type { Sql as SQL } from "postgres";
import { type MigrateSpaceOptions, migrateSpace } from "./migrate";

// Connection, failure assertions, and schema introspection are shared with the
// core suite.
export * from "../../migrate/test-utils";

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
