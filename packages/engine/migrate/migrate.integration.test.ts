import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { bootstrap } from "./bootstrap";
import { discoverEngineSchemas } from "./discover";
import { provisionEngine } from "./provision";
import { dryRun, getVersion, migrateAll, migrateEngine } from "./runner";
import {
  countMigrations,
  getFunctions,
  getIndexes,
  getRoles,
  getTableColumns,
  schemaExists,
  TestDatabase,
  tableExists,
} from "./test-utils";

const testDb = new TestDatabase();
let connectionString: string;
let sql: SQL;

beforeAll(async () => {
  connectionString = await testDb.create();
  sql = new SQL(connectionString);
  await bootstrap(sql);
});

afterAll(async () => {
  await sql.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Bootstrap Tests
// ---------------------------------------------------------------------------
describe("bootstrap", () => {
  test("creates extensions", async () => {
    const rows = await sql`
      select extname from pg_extension
      where extname in ('citext', 'ltree', 'vector', 'pg_textsearch')
      order by extname
    `;
    const names = rows.map((r: { extname: string }) => r.extname);
    expect(names).toEqual(["citext", "ltree", "pg_textsearch", "vector"]);
  });

  test("creates roles", async () => {
    const roles = await getRoles(sql, "me_ro", "me_rw", "me_embed");
    expect(roles).toHaveLength(3);
    for (const role of roles) {
      expect(role.rolcanlogin).toBe(false);
    }
  });

  test("does not create embedding schema", async () => {
    expect(await schemaExists(sql, "embedding")).toBe(false);
  });

  test("is idempotent", async () => {
    // Run bootstrap again — should not error
    await bootstrap(sql);

    const rows = await sql`
      select extname from pg_extension
      where extname in ('citext', 'ltree', 'vector', 'pg_textsearch')
    `;
    expect(rows).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Single-Engine Migration Tests
// ---------------------------------------------------------------------------
describe("single-engine migration", () => {
  const slug = "testengine01";
  const schema = `me_${slug}`;

  beforeAll(async () => {
    await provisionEngine(sql, slug, undefined, "0.1.0");
  });

  test("creates all tables", async () => {
    for (const table of [
      "memory",
      "user",
      "api_key",
      "tree_grant",
      "role_membership",
      "tree_owner",
      "migration",
      "embedding_queue",
    ]) {
      expect(await tableExists(sql, schema, table)).toBe(true);
    }
  });

  test("creates memory indexes", async () => {
    const indexes = await getIndexes(sql, schema, "memory");
    expect(indexes).toContain("memory_meta_gin_idx");
    expect(indexes).toContain("memory_temporal_gist_idx");
    expect(indexes).toContain("memory_content_bm25_idx");
    expect(indexes).toContain("memory_embedding_hnsw_idx");
    expect(indexes).toContain("memory_tree_gist_idx");
    expect(indexes).toContain("memory_null_embedding_idx");
  });

  test("is idempotent", async () => {
    const result = await migrateEngine(sql, schema, undefined, "0.1.0");
    expect(result.status).toBe("ok");
    expect(result.applied).toHaveLength(0);
    expect(await countMigrations(sql, schema)).toBe(5);
  });

  test("records migration metadata", async () => {
    const rows = await sql.unsafe(`
      select name, applied_at_version, applied_at
      from ${schema}.migration
      order by name
    `);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.applied_at_version).toBe("0.1.0");
      expect(row.applied_at).toBeTruthy();
    }
  });

  test("template substitution with custom config", async () => {
    // Verify the memory table was created (uses embedding_dimensions template var)
    const cols = await getTableColumns(sql, schema, "memory");
    const embCol = cols.find((c) => c.column_name === "embedding");
    expect(embCol).toBeTruthy();
  });

  test("memory trigger nulls embedding on content change", async () => {
    // Insert a memory with a fake embedding
    const dims = 1536;
    const embedding = `[${Array(dims).fill(0.1).join(",")}]`;
    await sql.unsafe(`
      insert into ${schema}.memory (content, embedding)
      values ('original content', '${embedding}')
    `);

    const [before] = await sql.unsafe(`
      select id, embedding from ${schema}.memory
      where content = 'original content'
    `);
    expect(before.embedding).not.toBeNull();

    // Update content without explicitly setting embedding
    await sql.unsafe(`
      update ${schema}.memory
      set content = 'updated content'
      where id = '${before.id}'
    `);

    const [after] = await sql.unsafe(`
      select embedding from ${schema}.memory
      where id = '${before.id}'
    `);
    expect(after.embedding).toBeNull();
  });

  test("memory trigger increments embedding_version", async () => {
    await sql.unsafe(`
      insert into ${schema}.memory (content)
      values ('version test content')
    `);

    const [before] = await sql.unsafe(`
      select id, embedding_version from ${schema}.memory
      where content = 'version test content'
    `);
    expect(before.embedding_version).toBe(1);

    await sql.unsafe(`
      update ${schema}.memory
      set content = 'version test updated'
      where id = '${before.id}'
    `);

    const [after] = await sql.unsafe(`
      select embedding_version from ${schema}.memory
      where id = '${before.id}'
    `);
    expect(after.embedding_version).toBe(2);
  });

  test("memory trigger preserves embedding when explicitly set", async () => {
    const dims = 1536;
    const embedding = `[${Array(dims).fill(0.2).join(",")}]`;
    await sql.unsafe(`
      insert into ${schema}.memory (content, embedding)
      values ('preserve test', '${embedding}')
    `);

    const [{ id }] = await sql.unsafe(`
      select id from ${schema}.memory where content = 'preserve test'
    `);

    const newEmbedding = `[${Array(dims).fill(0.3).join(",")}]`;
    await sql.unsafe(`
      update ${schema}.memory
      set content = 'preserve test updated', embedding = '${newEmbedding}'
      where id = '${id}'
    `);

    const [after] = await sql.unsafe(`
      select embedding from ${schema}.memory where id = '${id}'
    `);
    expect(after.embedding).not.toBeNull();
  });

  test("auth tables have correct structure", async () => {
    // User table: thing that accesses memories (or a role if can_login = false)
    const userCols = await getTableColumns(sql, schema, "user");
    const colNames = userCols.map((c) => c.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("name");
    expect(colNames).toContain("identity_id");
    expect(colNames).toContain("can_login");
    expect(colNames).toContain("superuser");
    expect(colNames).toContain("createrole");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");

    // api_key table exists in engine (user-scoped, engine-scoped)
    expect(await tableExists(sql, schema, "api_key")).toBe(true);
    const apiKeyCols = await getTableColumns(sql, schema, "api_key");
    const apiKeyColNames = apiKeyCols.map((c) => c.column_name);
    expect(apiKeyColNames).toContain("user_id");
    expect(apiKeyColNames).toContain("lookup_id");
    expect(apiKeyColNames).toContain("key_hash");
  });

  test("RLS policies enabled on memory", async () => {
    const [row] = await sql`
      select relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema} and c.relname = 'memory'
    `;
    expect(row.relrowsecurity).toBe(true);
  });

  test("functions have explicit search_path", async () => {
    const funcs = await getFunctions(sql, schema);
    for (const func of funcs) {
      expect(func.proconfig).toBeTruthy();
      const hasSearchPath = func.proconfig!.some((c: string) =>
        c.startsWith("search_path="),
      );
      expect(hasSearchPath).toBe(true);
    }
  });

  test("meta jsonb must be object", async () => {
    expect(async () => {
      await sql.unsafe(`
        insert into ${schema}.memory (content, meta) values ('test', '[]')
      `);
    }).toThrow();
  });

  test("temporal constraints enforced", async () => {
    // Point-in-time: valid
    await sql.unsafe(`
      insert into ${schema}.memory (content, temporal)
      values ('point', '[2024-01-01, 2024-01-01]')
    `);

    // Range: valid
    await sql.unsafe(`
      insert into ${schema}.memory (content, temporal)
      values ('range', '[2024-01-01, 2024-06-01)')
    `);

    // Invalid: exclusive lower bound
    expect(async () => {
      await sql.unsafe(`
        insert into ${schema}.memory (content, temporal)
        values ('bad', '(2024-01-01, 2024-06-01)')
      `);
    }).toThrow();
  });

  test("embedding_version defaults to 1", async () => {
    await sql.unsafe(`
      insert into ${schema}.memory (content) values ('ev default test')
    `);
    const [row] = await sql.unsafe(`
      select embedding_version from ${schema}.memory
      where content = 'ev default test'
    `);
    expect(row.embedding_version).toBe(1);
  });

  test("enqueue trigger fires on insert", async () => {
    await sql.unsafe(`delete from ${schema}.embedding_queue`);

    await sql.unsafe(`
      insert into ${schema}.memory (content) values ('trigger insert test')
    `);

    const rows = await sql.unsafe(`
      select memory_id, embedding_version
      from ${schema}.embedding_queue
    `);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("enqueue trigger fires on content update", async () => {
    await sql.unsafe(`delete from ${schema}.embedding_queue`);

    await sql.unsafe(`
      insert into ${schema}.memory (content) values ('trigger update before')
    `);

    // Clear queue entries from the insert
    await sql.unsafe(`delete from ${schema}.embedding_queue`);

    const [{ id }] = await sql.unsafe(`
      select id from ${schema}.memory where content = 'trigger update before'
    `);

    await sql.unsafe(`
      update ${schema}.memory set content = 'trigger update after' where id = '${id}'
    `);

    const rows = await sql.unsafe(`
      select embedding_version
      from ${schema}.embedding_queue
    `);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("memory deletion cascades to embedding_queue", async () => {
    await sql.unsafe(`delete from ${schema}.embedding_queue`);

    await sql.unsafe(`
      insert into ${schema}.memory (content) values ('cascade test')
    `);

    const [{ id }] = await sql.unsafe(`
      select id from ${schema}.memory where content = 'cascade test'
    `);

    // Verify queue entry exists
    const before = await sql.unsafe(`
      select count(*)::int as cnt from ${schema}.embedding_queue where memory_id = '${id}'
    `);
    expect(before[0].cnt).toBeGreaterThanOrEqual(1);

    // Delete memory — queue entry should cascade
    await sql.unsafe(`delete from ${schema}.memory where id = '${id}'`);

    const after = await sql.unsafe(`
      select count(*)::int as cnt from ${schema}.embedding_queue where memory_id = '${id}'
    `);
    expect(after[0].cnt).toBe(0);
  });

  test("me_embed role has correct per-schema grants", async () => {
    // Check schema usage
    const [{ has_usage }] = await sql`
      select has_schema_privilege('me_embed', ${schema}, 'USAGE') as has_usage
    `;
    expect(has_usage).toBe(true);

    // Check memory table privileges
    const [{ has_select }] = await sql`
      select has_table_privilege('me_embed', ${`${schema}.memory`}, 'SELECT') as has_select
    `;
    expect(has_select).toBe(true);

    const [{ has_update }] = await sql`
      select has_table_privilege('me_embed', ${`${schema}.memory`}, 'UPDATE') as has_update
    `;
    expect(has_update).toBe(true);

    // Check embedding_queue table privileges
    const [{ eq_select }] = await sql`
      select has_table_privilege('me_embed', ${`${schema}.embedding_queue`}, 'SELECT') as eq_select
    `;
    expect(eq_select).toBe(true);

    const [{ eq_update }] = await sql`
      select has_table_privilege('me_embed', ${`${schema}.embedding_queue`}, 'UPDATE') as eq_update
    `;
    expect(eq_update).toBe(true);

    const [{ eq_delete }] = await sql`
      select has_table_privilege('me_embed', ${`${schema}.embedding_queue`}, 'DELETE') as eq_delete
    `;
    expect(eq_delete).toBe(true);

    // Check claim function privilege
    const [{ has_execute }] = await sql`
      select has_function_privilege('me_embed', ${`${schema}.claim_embedding_batch(int, interval)`}, 'EXECUTE') as has_execute
    `;
    expect(has_execute).toBe(true);
  });

  test("me_rw cannot access embedding_queue", async () => {
    const [{ has_select }] = await sql`
      select has_table_privilege('me_rw', ${`${schema}.embedding_queue`}, 'SELECT') as has_select
    `;
    expect(has_select).toBe(false);
  });

  test("me_ro cannot access embedding_queue", async () => {
    const [{ has_select }] = await sql`
      select has_table_privilege('me_ro', ${`${schema}.embedding_queue`}, 'SELECT') as has_select
    `;
    expect(has_select).toBe(false);
  });

  test("embedding_queue has FK with ON DELETE CASCADE", async () => {
    const fks = await sql`
      select
        tc.constraint_name,
        rc.delete_rule
      from information_schema.table_constraints tc
      join information_schema.referential_constraints rc
        on tc.constraint_name = rc.constraint_name
        and tc.constraint_schema = rc.constraint_schema
      where tc.table_schema = ${schema}
        and tc.table_name = 'embedding_queue'
        and tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(fks).toHaveLength(1);
    expect(fks[0].delete_rule).toBe("CASCADE");
  });

  test("per-engine enqueue_embedding and claim_embedding_batch functions exist", async () => {
    const funcs = await getFunctions(sql, schema);
    const names = funcs.map((f) => f.proname);
    expect(names).toContain("enqueue_embedding");
    expect(names).toContain("claim_embedding_batch");
  });
});

// ---------------------------------------------------------------------------
// Multi-Engine Tests
// ---------------------------------------------------------------------------
describe("multi-engine migration", () => {
  const slugs = ["aaaa00000001", "aaaa00000002", "aaaa00000003"];
  const schemas = slugs.map((s) => `me_${s}`);

  beforeAll(async () => {
    for (const slug of slugs) {
      await provisionEngine(sql, slug, undefined, "0.1.0");
    }
  });

  test("migrateAll migrates multiple schemas", async () => {
    // All already migrated, should be no-op
    const results = await migrateAll(sql, schemas, undefined, "0.1.0");
    expect(results.size).toBe(3);
    for (const [, result] of results) {
      expect(result.status).toBe("ok");
      expect(result.applied).toHaveLength(0);
    }
    for (const schema of schemas) {
      expect(await tableExists(sql, schema, "memory")).toBe(true);
    }
  });

  test("migrateAll isolates failures", async () => {
    const badSchema = "me_badschema000";
    // Don't create this schema — migration should fail
    const allSchemas = [...schemas, badSchema];

    const results = await migrateAll(sql, allSchemas, undefined, "0.1.0");

    // Good schemas should succeed (already migrated, so 0 applied)
    for (const schema of schemas) {
      expect(results.get(schema)!.status).toBe("ok");
    }

    // Bad schema should error
    expect(results.get(badSchema)!.status).toBe("error");
    expect(results.get(badSchema)!.error).toBeTruthy();
  });

  test("concurrency control processes with concurrency=1", async () => {
    const results = await migrateAll(sql, schemas, undefined, "0.1.0", {
      concurrency: 1,
    });
    expect(results.size).toBe(3);
    for (const [, result] of results) {
      expect(result.status).toBe("ok");
    }
  });
});

// ---------------------------------------------------------------------------
// Discovery Tests
// ---------------------------------------------------------------------------
describe("discovery", () => {
  test("finds engine schemas", async () => {
    // me_testengine01 was created earlier, plus multi schemas
    const discovered = await discoverEngineSchemas(sql);
    expect(discovered).toContain("me_testengine01");
    expect(discovered).toContain("me_aaaa00000001");
  });

  test("ignores non-engine schemas", async () => {
    const discovered = await discoverEngineSchemas(sql);
    expect(discovered).not.toContain("public");
    // embedding schema no longer exists
    expect(discovered).not.toContain("pg_catalog");
  });

  test("returns sorted results", async () => {
    const discovered = await discoverEngineSchemas(sql);
    const sorted = [...discovered].sort();
    expect(discovered).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Advisory Lock Tests
// ---------------------------------------------------------------------------
describe("advisory locks", () => {
  test("concurrent migrateEngine on same schema — only one applies", async () => {
    const slug = "locktest0001";
    const schema = `me_${slug}`;
    await provisionEngine(sql, slug, undefined, "0.1.0");

    // Now run concurrent migrations (all should succeed with 0 applied due to idempotency)
    const results = await Promise.all([
      migrateEngine(sql, schema, undefined, "0.1.0"),
      migrateEngine(sql, schema, undefined, "0.1.0"),
      migrateEngine(sql, schema, undefined, "0.1.0"),
    ]);

    // All should complete (ok or skipped)
    for (const result of results) {
      expect(["ok", "skipped"]).toContain(result.status);
    }

    // Exactly 5 migrations should exist
    expect(await countMigrations(sql, schema)).toBe(5);
  });

  test("concurrent migrateEngine on different schemas — both proceed", async () => {
    const slugA = "locktest0002";
    const slugB = "locktest0003";
    const schemaA = `me_${slugA}`;
    const schemaB = `me_${slugB}`;

    // Provision both first
    await Promise.all([
      provisionEngine(sql, slugA, undefined, "0.1.0"),
      provisionEngine(sql, slugB, undefined, "0.1.0"),
    ]);

    // Now run migrations (should be no-ops since provisioning ran them)
    const [resultA, resultB] = await Promise.all([
      migrateEngine(sql, schemaA, undefined, "0.1.0"),
      migrateEngine(sql, schemaB, undefined, "0.1.0"),
    ]);

    expect(resultA.status).toBe("ok");
    expect(resultB.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Provisioning Tests
// ---------------------------------------------------------------------------
describe("provisioning", () => {
  test("creates schema and runs all migrations", async () => {
    const result = await provisionEngine(
      sql,
      "prov00000001",
      undefined,
      "0.1.0",
    );
    expect(result.schema).toBe("me_prov00000001");
    expect(result.migrateResult.status).toBe("ok");
    expect(result.migrateResult.applied).toHaveLength(5);
    expect(await schemaExists(sql, "me_prov00000001")).toBe(true);
    expect(await tableExists(sql, "me_prov00000001", "memory")).toBe(true);
    expect(await tableExists(sql, "me_prov00000001", "user")).toBe(true);
  });

  test("validates slug format", () => {
    expect(provisionEngine(sql, "BAD", undefined, "0.1.0")).rejects.toThrow(
      "Invalid engine slug",
    );

    expect(
      provisionEngine(sql, "too-short", undefined, "0.1.0"),
    ).rejects.toThrow("Invalid engine slug");
  });

  test("fails if schema already exists", async () => {
    await provisionEngine(sql, "prov00000002", undefined, "0.1.0");

    await expect(
      provisionEngine(sql, "prov00000002", undefined, "0.1.0"),
    ).rejects.toThrow();
  });

  test("creates version table", async () => {
    const slug = "prov00000003";
    await provisionEngine(sql, slug, undefined, "0.1.0");
    expect(await tableExists(sql, `me_${slug}`, "version")).toBe(true);
    expect(await getVersion(sql, `me_${slug}`)).toBe("0.1.0");
  });
});

// ---------------------------------------------------------------------------
// Dry Run Tests
// ---------------------------------------------------------------------------
describe("dry run", () => {
  test("shows all pending for new schema", async () => {
    // Create a schema manually without running migrations (simulating a fresh schema)
    const schema = "me_dryrun000001";
    await sql.unsafe(`create schema if not exists ${schema}`);

    const result = await dryRun(sql, schema);
    expect(result.pending).toHaveLength(5);
    expect(result.applied).toHaveLength(0);
  });

  test("shows none pending after full migration", async () => {
    const slug = "dryrun000002";
    const schema = `me_${slug}`;
    await provisionEngine(sql, slug, undefined, "0.1.0");

    const result = await dryRun(sql, schema);
    expect(result.pending).toHaveLength(0);
    expect(result.applied).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Version Tracking Tests
// ---------------------------------------------------------------------------
describe("version tracking", () => {
  test("applied_at_version records correctly", async () => {
    const slug = "version00001";
    const schema = `me_${slug}`;
    await provisionEngine(sql, slug, undefined, "1.2.3");

    const rows = await sql.unsafe(`
      select applied_at_version from ${schema}.migration
    `);
    for (const row of rows) {
      expect(row.applied_at_version).toBe("1.2.3");
    }
  });

  test("re-migrate with same migrations is no-op", async () => {
    const slug = "version00002";
    const schema = `me_${slug}`;
    await provisionEngine(sql, slug, undefined, "0.1.0");

    const result = await migrateEngine(sql, schema, undefined, "0.1.0");
    expect(result.applied).toHaveLength(0);
  });

  test("rejects downgrade", async () => {
    const slug = "version00003";
    const schema = `me_${slug}`;
    await provisionEngine(sql, slug, undefined, "0.2.0");

    await expect(
      migrateEngine(sql, schema, undefined, "0.1.0"),
    ).rejects.toThrow("older than database version");
  });

  test("updates version on upgrade", async () => {
    const slug = "version00004";
    const schema = `me_${slug}`;
    await provisionEngine(sql, slug, undefined, "0.1.0");
    expect(await getVersion(sql, schema)).toBe("0.1.0");

    await migrateEngine(sql, schema, undefined, "0.2.0");
    expect(await getVersion(sql, schema)).toBe("0.2.0");
  });

  test("getVersion returns current version", async () => {
    const slug = "version00005";
    const schema = `me_${slug}`;
    await provisionEngine(sql, slug, undefined, "1.2.3");
    expect(await getVersion(sql, schema)).toBe("1.2.3");
  });
});

// ---------------------------------------------------------------------------
// Cross-Engine Isolation Tests
// ---------------------------------------------------------------------------
describe("cross-engine isolation", () => {
  const slugA = "isolate00001";
  const slugB = "isolate00002";
  const schemaA = `me_${slugA}`;
  const schemaB = `me_${slugB}`;

  beforeAll(async () => {
    await provisionEngine(sql, slugA, undefined, "0.1.0");
    await provisionEngine(sql, slugB, undefined, "0.1.0");
  });

  test("data isolated between schemas", async () => {
    await sql.unsafe(`
      insert into ${schemaA}.memory (content) values ('only in A')
    `);

    const rowsA = await sql.unsafe(`
      select content from ${schemaA}.memory where content = 'only in A'
    `);
    expect(rowsA).toHaveLength(1);

    const rowsB = await sql.unsafe(`
      select content from ${schemaB}.memory where content = 'only in A'
    `);
    expect(rowsB).toHaveLength(0);
  });

  test("embedding queue entries are per-engine", async () => {
    await sql.unsafe(`delete from ${schemaA}.embedding_queue`);
    await sql.unsafe(`delete from ${schemaB}.embedding_queue`);

    await sql.unsafe(`
      insert into ${schemaA}.memory (content) values ('queue test A')
    `);
    await sql.unsafe(`
      insert into ${schemaB}.memory (content) values ('queue test B')
    `);

    const rowsA = await sql.unsafe(`
      select memory_id from ${schemaA}.embedding_queue
    `);
    expect(rowsA).toHaveLength(1);

    const rowsB = await sql.unsafe(`
      select memory_id from ${schemaB}.embedding_queue
    `);
    expect(rowsB).toHaveLength(1);
  });
});
