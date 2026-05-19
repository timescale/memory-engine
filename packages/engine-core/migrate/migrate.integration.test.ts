import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { bootstrapEngineDatabase } from "./bootstrap";
import { migrateEngine } from "./migrate";

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

function getSql(): SQL {
  if (!sql) throw new Error("test database is not initialized");
  return sql;
}

function randomSlug(): string {
  return `t${Math.random().toString(36).slice(2, 13).padEnd(11, "0")}`;
}

function schemaFor(slug: string): string {
  return `me_${slug}`;
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

async function schemaExists(schema: string): Promise<boolean> {
  const [{ exists }] = await getSql()`
    select exists (
      select 1
      from information_schema.schemata
      where schema_name = ${schema}
    ) as exists
  `;
  return exists;
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const [{ exists }] = await getSql()`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = ${schema}
        and table_name = ${table}
    ) as exists
  `;
  return exists;
}

async function migrationCount(schema: string): Promise<number> {
  const [{ count }] = await getSql()`
    select count(*)::int as count
    from ${getSql()(schema)}.migration
  `;
  return count;
}

async function engineVersion(schema: string): Promise<string> {
  const [{ version }] = await getSql()`
    select version
    from ${getSql()(schema)}.version
  `;
  return version;
}

beforeAll(async () => {
  const connectionString = await createTestDatabase();
  sql = new SQL(connectionString);
  await bootstrapEngineDatabase(sql);
});

afterAll(async () => {
  await sql?.close();
  sql = undefined;
  await dropTestDatabase();
});

describe("migrateEngine", () => {
  test("provisions a new engine schema", async () => {
    const slug = randomSlug();
    const schema = schemaFor(slug);

    await migrateEngine(getSql(), { slug, targetVersion: "0.1.0" });

    expect(await schemaExists(schema)).toBe(true);
    expect(await tableExists(schema, "version")).toBe(true);
    expect(await tableExists(schema, "migration")).toBe(true);
    expect(await tableExists(schema, "user")).toBe(true);
    expect(await tableExists(schema, "role_membership")).toBe(true);
    expect(await tableExists(schema, "tree_owner")).toBe(true);
    expect(await tableExists(schema, "tree_grant")).toBe(true);
    expect(await tableExists(schema, "memory")).toBe(true);
    expect(await tableExists(schema, "embedding_queue")).toBe(true);
    expect(await engineVersion(schema)).toBe("0.1.0");

    const rows = await getSql()`
      select name, applied_at_version, applied_at
      from ${getSql()(schema)}.migration
      order by name
    `;
    expect(rows.map((row: { name: string }) => row.name)).toEqual([
      "001_user",
      "002_role_membership",
      "003_tree_ownership",
      "004_tree_grant",
      "005_memory",
      "006_embedding_queue",
    ]);
    for (const row of rows as Array<{
      applied_at_version: string;
      applied_at: Date;
    }>) {
      expect(row.applied_at_version).toBe("0.1.0");
      expect(row.applied_at).toBeTruthy();
    }
  });

  test("is idempotent", async () => {
    const slug = randomSlug();
    const schema = schemaFor(slug);

    await migrateEngine(getSql(), { slug, targetVersion: "0.1.0" });
    await migrateEngine(getSql(), { slug, targetVersion: "0.1.0" });

    expect(await migrationCount(schema)).toBe(6);
    expect(await engineVersion(schema)).toBe("0.1.0");
  });

  test("rejects invalid slug", async () => {
    await expect(
      migrateEngine(getSql(), { slug: "bad-slug", targetVersion: "0.1.0" }),
    ).rejects.toThrow("Invalid engine slug");
  });

  test("rejects invalid targetVersion", async () => {
    await expect(
      migrateEngine(getSql(), { slug: randomSlug(), targetVersion: "nope" }),
    ).rejects.toThrow("Invalid target version");
  });

  test("rejects downgrade", async () => {
    const slug = randomSlug();

    await migrateEngine(getSql(), { slug, targetVersion: "0.2.0" });

    await expect(
      migrateEngine(getSql(), { slug, targetVersion: "0.1.0" }),
    ).rejects.toThrow("older than database version");
  });

  test("allows equal current version rerun", async () => {
    const slug = randomSlug();
    const schema = schemaFor(slug);

    await migrateEngine(getSql(), { slug, targetVersion: "0.2.0" });
    await migrateEngine(getSql(), { slug, targetVersion: "0.2.0" });

    expect(await migrationCount(schema)).toBe(6);
    expect(await engineVersion(schema)).toBe("0.2.0");
  });

  test("allows upgrade without pending migrations", async () => {
    const slug = randomSlug();
    const schema = schemaFor(slug);

    await migrateEngine(getSql(), { slug, targetVersion: "0.1.0" });
    await migrateEngine(getSql(), { slug, targetVersion: "0.2.0" });

    expect(await migrationCount(schema)).toBe(6);
    expect(await engineVersion(schema)).toBe("0.2.0");
  });

  test("rejects unsafe shardId", async () => {
    await expect(
      migrateEngine(getSql(), {
        slug: randomSlug(),
        targetVersion: "0.1.0",
        shardId: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("shardId must be a safe integer");
  });

  test("grants and revokes tree actions", async () => {
    const slug = randomSlug();
    const schema = schemaFor(slug);
    const db = getSql();

    await migrateEngine(db, { slug, targetVersion: "0.1.0" });

    const [{ id: ownerId }] = await db`
      insert into ${db(schema)}."user" (name)
      values (${`owner_${slug}`})
      returning id
    `;
    const [{ id: granteeId }] = await db`
      insert into ${db(schema)}."user" (name)
      values (${`grantee_${slug}`})
      returning id
    `;
    const [{ id: outsiderId }] = await db`
      insert into ${db(schema)}."user" (name)
      values (${`outsider_${slug}`})
      returning id
    `;

    await db`
      insert into ${db(schema)}.tree_owner (tree_path, user_id)
      values ('project'::ltree, ${ownerId}::uuid)
    `;

    try {
      await db`
        select ${db(schema)}.grant_tree_actions(
          ${outsiderId}::uuid,
          array['read']::text[],
          'project.alpha'::ltree,
          ${granteeId}::uuid
        )
      `;
      throw new Error("expected grant_tree_actions to reject");
    } catch (error) {
      expect(String(error)).toContain(
        "must be a superuser or own the tree path",
      );
    }

    await db`
      select ${db(schema)}.grant_tree_actions(
        ${ownerId}::uuid,
        array['read']::text[],
        'project.alpha'::ltree,
        ${granteeId}::uuid
      )
    `;
    await db`
      select ${db(schema)}.grant_tree_actions(
        ${ownerId}::uuid,
        array['update']::text[],
        'project.alpha'::ltree,
        ${granteeId}::uuid
      )
    `;

    const [{ actions: grantedActions }] = await db`
      select actions
      from ${db(schema)}.tree_grant
      where user_id = ${granteeId}::uuid
      and tree_path = 'project.alpha'::ltree
    `;
    expect(grantedActions).toEqual(["read", "update"]);

    await db`
      select ${db(schema)}.revoke_tree_actions(
        ${ownerId}::uuid,
        array['read']::text[],
        'project.alpha'::ltree,
        ${granteeId}::uuid
      )
    `;

    const [{ actions: remainingActions }] = await db`
      select actions
      from ${db(schema)}.tree_grant
      where user_id = ${granteeId}::uuid
      and tree_path = 'project.alpha'::ltree
    `;
    expect(remainingActions).toEqual(["update"]);

    await db`
      select ${db(schema)}.revoke_tree_actions(
        ${ownerId}::uuid,
        array['update']::text[],
        'project.alpha'::ltree,
        ${granteeId}::uuid
      )
    `;

    const [{ exists }] = await db`
      select exists
      (
        select 1
        from ${db(schema)}.tree_grant
        where user_id = ${granteeId}::uuid
        and tree_path = 'project.alpha'::ltree
      ) as exists
    `;
    expect(exists).toBe(false);
  }, 30_000);
});
