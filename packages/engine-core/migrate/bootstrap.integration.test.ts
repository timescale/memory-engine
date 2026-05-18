import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL, semver } from "bun";
import { bootstrapEngineDatabase } from "./bootstrap";

const adminUrl =
  process.env.ENGINE_CORE_TEST_DATABASE_URL ??
  "postgresql://postgres@localhost:5432/postgres";

// These tests expect the local Postgres image from docker/Dockerfile.postgres,
// usually started with `./bun run pg`, unless ENGINE_CORE_TEST_DATABASE_URL is set.

let dbName: string | undefined;
let sql: SQL | undefined;

function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
}

async function createTestDatabase(): Promise<string> {
  dbName = `test_engine_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  assertSafeIdentifier(dbName);

  const admin = new SQL(adminUrl);
  try {
    await admin.unsafe(`create database ${dbName}`);
  } finally {
    await admin.close();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function dropTestDatabase(): Promise<void> {
  if (!dbName) return;
  assertSafeIdentifier(dbName);

  const admin = new SQL(adminUrl);
  try {
    await admin`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${dbName}
        and pid <> pg_backend_pid()
    `;
    await admin.unsafe(`drop database if exists ${dbName}`);
  } finally {
    await admin.close();
    dbName = undefined;
  }
}

function getSql(): SQL {
  if (!sql) throw new Error("test database is not initialized");
  return sql;
}

beforeAll(async () => {
  const connectionString = await createTestDatabase();
  sql = new SQL(connectionString);
});

afterAll(async () => {
  await sql?.close();
  sql = undefined;
  await dropTestDatabase();
});

describe("bootstrapEngineDatabase", () => {
  test("creates required extensions in public", async () => {
    await bootstrapEngineDatabase(getSql());

    const rows = await getSql()`
      select e.extname, e.extversion, n.nspname
      from pg_extension e
      inner join pg_namespace n on n.oid = e.extnamespace
      where e.extname in ('citext', 'ltree', 'vector', 'pg_textsearch')
      order by e.extname
    `;

    expect(rows.map((row: { extname: string }) => row.extname)).toEqual([
      "citext",
      "ltree",
      "pg_textsearch",
      "vector",
    ]);

    const minimumVersions = new Map([
      ["citext", "1.6"],
      ["ltree", "1.3"],
      ["pg_textsearch", "1.1.0"],
      ["vector", "0.8.2"],
    ]);
    for (const row of rows as Array<{
      extname: string;
      extversion: string;
      nspname: string;
    }>) {
      expect(row.nspname).toBe("public");
      expect(
        semver.order(row.extversion, minimumVersions.get(row.extname)!),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  test("creates required nologin roles", async () => {
    await bootstrapEngineDatabase(getSql());

    const rows = await getSql()`
      select rolname, rolcanlogin
      from pg_roles
      where rolname in ('me_ro', 'me_rw', 'me_embed')
      order by rolname
    `;

    expect(rows).toHaveLength(3);
    expect(rows.map((row: { rolname: string }) => row.rolname)).toEqual([
      "me_embed",
      "me_ro",
      "me_rw",
    ]);
    for (const row of rows as Array<{ rolcanlogin: boolean }>) {
      expect(row.rolcanlogin).toBe(false);
    }
  });

  test("is idempotent", async () => {
    await bootstrapEngineDatabase(getSql());
    await bootstrapEngineDatabase(getSql());

    const [{ extensionCount }] = await getSql()`
      select count(*)::int as "extensionCount"
      from pg_extension
      where extname in ('citext', 'ltree', 'vector', 'pg_textsearch')
    `;
    const [{ roleCount }] = await getSql()`
      select count(*)::int as "roleCount"
      from pg_roles
      where rolname in ('me_ro', 'me_rw', 'me_embed')
    `;

    expect(extensionCount).toBe(4);
    expect(roleCount).toBe(3);
  });
});
