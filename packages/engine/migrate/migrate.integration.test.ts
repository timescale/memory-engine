import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bootstrap } from "./bootstrap";
import { discoverEngineSchemas } from "./discover";
import { provisionEngine } from "./provision";
import { dryRun, migrateAll, migrateEngine } from "./runner";
import {
  TestDatabase,
  countMigrations,
  getAppliedMigrations,
  getFunctions,
  getIndexes,
  getRoles,
  getTableColumns,
  schemaExists,
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

  test("creates embedding schema and tables", async () => {
    expect(await schemaExists(sql, "embedding")).toBe(true);
    expect(await tableExists(sql, "embedding", "queue")).toBe(true);
    expect(await tableExists(sql, "embedding", "queue_hist")).toBe(true);

    const cols = await getTableColumns(sql, "embedding", "queue");
    const colNames = cols.map((c) => c.column_name);
    expect(colNames).toContain("schema_name");
    expect(colNames).toContain("memory_id");
    expect(colNames).toContain("embedding_version");
    expect(colNames).toContain("vt");
    expect(colNames).toContain("outcome");
    expect(colNames).toContain("attempts");
    expect(colNames).toContain("max_attempts");
    expect(colNames).toContain("last_error");
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

  test("creates claim_batch function", async () => {
    const funcs = await getFunctions(sql, "embedding");
    const names = funcs.map((f) => f.proname);
    expect(names).toContain("claim_batch");
  });
});

// ---------------------------------------------------------------------------
// Single-Engine Migration Tests
// ---------------------------------------------------------------------------
describe("single-engine migration", () => {
  const schema = "me_testengine01";

  beforeAll(async () => {
    await sql.unsafe(`create schema if not exists ${schema}`);
    await sql.unsafe(
      `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
    );
    await migrateEngine(sql, schema, undefined, "0.1.0");
  });

  test("creates all tables", async () => {
    for (const table of [
      "memory",
      "principal",
      "api_key",
      "tree_grant",
      "role_membership",
      "tree_owner",
      "migration",
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
    expect(await countMigrations(sql, schema)).toBe(4);
  });

  test("records migration metadata", async () => {
    const rows = await sql.unsafe(`
      select name, applied_at_version, applied_at
      from ${schema}.migration
      order by name
    `);
    expect(rows).toHaveLength(4);
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
    const principalCols = await getTableColumns(sql, schema, "principal");
    const colNames = principalCols.map((c) => c.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("email");
    expect(colNames).toContain("name");
    expect(colNames).toContain("superuser");
    expect(colNames).toContain("can_login");
    expect(colNames).toContain("password_hash");

    const apiKeyCols = await getTableColumns(sql, schema, "api_key");
    const akNames = apiKeyCols.map((c) => c.column_name);
    expect(akNames).toContain("lookup_id");
    expect(akNames).toContain("key_hash");
    expect(akNames).toContain("principal_id");
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
    // Clear any existing queue entries
    await sql.unsafe(`delete from embedding.queue`);

    await sql.unsafe(`
      insert into ${schema}.memory (content) values ('trigger insert test')
    `);

    const rows = await sql.unsafe(`
      select schema_name, memory_id, embedding_version
      from embedding.queue
      where schema_name = '${schema}'
    `);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].schema_name).toBe(schema);
  });

  test("enqueue trigger fires on content update", async () => {
    await sql.unsafe(`delete from embedding.queue`);

    await sql.unsafe(`
      insert into ${schema}.memory (content) values ('trigger update before')
    `);

    // Clear queue entries from the insert
    await sql.unsafe(`delete from embedding.queue`);

    const [{ id }] = await sql.unsafe(`
      select id from ${schema}.memory where content = 'trigger update before'
    `);

    await sql.unsafe(`
      update ${schema}.memory set content = 'trigger update after' where id = '${id}'
    `);

    const rows = await sql.unsafe(`
      select schema_name, embedding_version
      from embedding.queue
      where schema_name = '${schema}'
    `);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("me_embed role has correct per-schema grants", async () => {
    // Check schema usage
    const [{ has_usage }] = await sql`
      select has_schema_privilege('me_embed', ${schema}, 'USAGE') as has_usage
    `;
    expect(has_usage).toBe(true);

    // Check table privileges
    const [{ has_select }] = await sql`
      select has_table_privilege('me_embed', ${schema + ".memory"}, 'SELECT') as has_select
    `;
    expect(has_select).toBe(true);

    const [{ has_update }] = await sql`
      select has_table_privilege('me_embed', ${schema + ".memory"}, 'UPDATE') as has_update
    `;
    expect(has_update).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-Engine Tests
// ---------------------------------------------------------------------------
describe("multi-engine migration", () => {
  const schemas = [
    "me_aaaa00000001",
    "me_aaaa00000002",
    "me_aaaa00000003",
  ];

  beforeAll(async () => {
    for (const schema of schemas) {
      await sql.unsafe(`create schema if not exists ${schema}`);
      await sql.unsafe(
        `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
      );
    }
  });

  test("migrateAll migrates multiple schemas", async () => {
    const results = await migrateAll(sql, schemas, undefined, "0.1.0");
    expect(results.size).toBe(3);
    for (const [, result] of results) {
      expect(result.status).toBe("ok");
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
    expect(discovered).not.toContain("embedding");
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
    const schema = "me_locktest0001";
    await sql.unsafe(`create schema if not exists ${schema}`);
    await sql.unsafe(
      `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
    );

    const results = await Promise.all([
      migrateEngine(sql, schema, undefined, "0.1.0"),
      migrateEngine(sql, schema, undefined, "0.1.0"),
      migrateEngine(sql, schema, undefined, "0.1.0"),
    ]);

    const applied = results.filter((r) => r.status === "ok" && r.applied.length > 0);
    const skipped = results.filter((r) => r.status === "skipped");

    // At least one should have applied, others may skip or apply 0
    expect(applied.length + skipped.length + results.filter((r) => r.status === "ok" && r.applied.length === 0).length).toBe(3);
    // Exactly 4 migrations should exist
    expect(await countMigrations(sql, schema)).toBe(4);
  });

  test("concurrent migrateEngine on different schemas — both proceed", async () => {
    const schemaA = "me_locktest0002";
    const schemaB = "me_locktest0003";

    for (const schema of [schemaA, schemaB]) {
      await sql.unsafe(`create schema if not exists ${schema}`);
      await sql.unsafe(
        `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
      );
    }

    const [resultA, resultB] = await Promise.all([
      migrateEngine(sql, schemaA, undefined, "0.1.0"),
      migrateEngine(sql, schemaB, undefined, "0.1.0"),
    ]);

    expect(resultA.status).toBe("ok");
    expect(resultA.applied).toHaveLength(4);
    expect(resultB.status).toBe("ok");
    expect(resultB.applied).toHaveLength(4);
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
    expect(result.migrateResult.applied).toHaveLength(4);
    expect(await schemaExists(sql, "me_prov00000001")).toBe(true);
    expect(await tableExists(sql, "me_prov00000001", "memory")).toBe(true);
    expect(await tableExists(sql, "me_prov00000001", "principal")).toBe(true);
  });

  test("validates slug format", () => {
    expect(
      provisionEngine(sql, "BAD", undefined, "0.1.0"),
    ).rejects.toThrow("Invalid engine slug");

    expect(
      provisionEngine(sql, "too-short", undefined, "0.1.0"),
    ).rejects.toThrow("Invalid engine slug");
  });

  test("is idempotent", async () => {
    const result1 = await provisionEngine(
      sql,
      "prov00000002",
      undefined,
      "0.1.0",
    );
    expect(result1.migrateResult.applied).toHaveLength(4);

    const result2 = await provisionEngine(
      sql,
      "prov00000002",
      undefined,
      "0.1.0",
    );
    expect(result2.migrateResult.applied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dry Run Tests
// ---------------------------------------------------------------------------
describe("dry run", () => {
  test("shows all pending for new schema", async () => {
    const schema = "me_dryrun000001";
    await sql.unsafe(`create schema if not exists ${schema}`);

    const result = await dryRun(sql, schema);
    expect(result.pending).toHaveLength(4);
    expect(result.applied).toHaveLength(0);
  });

  test("shows none pending after full migration", async () => {
    const schema = "me_dryrun000002";
    await sql.unsafe(`create schema if not exists ${schema}`);
    await sql.unsafe(
      `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
    );
    await migrateEngine(sql, schema, undefined, "0.1.0");

    const result = await dryRun(sql, schema);
    expect(result.pending).toHaveLength(0);
    expect(result.applied).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Version Tracking Tests
// ---------------------------------------------------------------------------
describe("version tracking", () => {
  test("applied_at_version records correctly", async () => {
    const schema = "me_version00001";
    await sql.unsafe(`create schema if not exists ${schema}`);
    await sql.unsafe(
      `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
    );
    await migrateEngine(sql, schema, undefined, "1.2.3");

    const rows = await sql.unsafe(`
      select applied_at_version from ${schema}.migration
    `);
    for (const row of rows) {
      expect(row.applied_at_version).toBe("1.2.3");
    }
  });

  test("re-migrate with same migrations is no-op", async () => {
    const schema = "me_version00002";
    await sql.unsafe(`create schema if not exists ${schema}`);
    await sql.unsafe(
      `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
    );

    const result1 = await migrateEngine(sql, schema, undefined, "0.1.0");
    expect(result1.applied).toHaveLength(4);

    const result2 = await migrateEngine(sql, schema, undefined, "0.2.0");
    expect(result2.applied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-Engine Isolation Tests
// ---------------------------------------------------------------------------
describe("cross-engine isolation", () => {
  const schemaA = "me_isolate00001";
  const schemaB = "me_isolate00002";

  beforeAll(async () => {
    await provisionEngine(sql, "isolate00001", undefined, "0.1.0");
    await provisionEngine(sql, "isolate00002", undefined, "0.1.0");
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

  test("embedding queue entries carry correct schema_name", async () => {
    await sql.unsafe(`delete from embedding.queue`);

    await sql.unsafe(`
      insert into ${schemaA}.memory (content) values ('queue test A')
    `);
    await sql.unsafe(`
      insert into ${schemaB}.memory (content) values ('queue test B')
    `);

    const rows = await sql.unsafe(`
      select schema_name from embedding.queue order by schema_name
    `);
    const schemas = rows.map((r: { schema_name: string }) => r.schema_name);
    expect(schemas).toContain(schemaA);
    expect(schemas).toContain(schemaB);
  });
});
