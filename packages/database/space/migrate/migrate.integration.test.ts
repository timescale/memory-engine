// Integration tests for per-space data-plane migrations (migrateSpace) and the
// shared database bootstrap (bootstrapSpaceDatabase).
//
// Provisioning a space is latency-bound (many sequential statements; ~seconds
// against a remote ghost db), so we provision a small fixed set of spaces once
// in beforeAll — concurrently, via Promise.all — and run fast read-only
// assertions against them. Only the handful of tests that need a private,
// mutable space provision their own.
//
// Tests are serial within the file (Bun 1.3's `test.concurrent` deadlocks when
// many heavy migration transactions overlap). Parallelism comes from two
// places instead: concurrent provisioning in beforeAll, and running the core
// and space suites as separate processes (`bun run test:db`). Spaces are
// isolated by unique `me_<slug>` schema, so those processes never collide.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql as SQL } from "postgres";
import { SPACE_SCHEMA_VERSION } from "../version";
import { bootstrapSpaceDatabase } from "./bootstrap";
import { migrateSpace, provisionSpace } from "./migrate";
import {
  appliedMigrations,
  columnType,
  connect,
  expectReject,
  getIndexReloptions,
  getSchemaVersion,
  listFunctions,
  listIndexes,
  listTables,
  listTriggers,
  randomSlug,
  schemaExists,
  TestSpace,
  tableExists,
  withTestSpace,
} from "./test-utils";

const EXPECTED_TABLES = ["embedding_queue", "memory", "migration", "version"];

const EXPECTED_MIGRATIONS = ["001_memory", "002_embedding_queue"];

const EXPECTED_MEMORY_FUNCTIONS = [
  "copy_tree",
  "count_tree",
  "create_memory",
  "delete_memory",
  "delete_tree",
  "get_memory",
  "has_tree_access",
  "hybrid_search_memory",
  "list_tree",
  "move_tree",
  "patch_memory",
  "search_memory",
  "tree_access",
];

const EXPECTED_QUEUE_FUNCTIONS = [
  "claim_embedding_batch",
  "enqueue_embedding",
  "prune_embedding_queue",
];

const EXPECTED_MEMORY_INDEXES = [
  "memory_content_bm25_idx",
  "memory_embedding_hnsw_idx",
  "memory_meta_gin_idx",
  "memory_temporal_gist_idx",
  "memory_tree_gist_idx",
];

let sql: SQL;
// Shared spaces, provisioned once. Read-only shape/functional assertions run
// against these; their schemas never change underneath each other.
let canonical: TestSpace; // default params; also used for functional smoke
let dim768: TestSpace; // custom embedding dimension
let customIdx: TestSpace; // custom HNSW + BM25 index parameters

beforeAll(async () => {
  sql = connect(12);
  await bootstrapSpaceDatabase(sql);
  [canonical, dim768, customIdx] = await Promise.all([
    TestSpace.create(sql),
    TestSpace.create(sql, { embeddingDimensions: 768 }),
    TestSpace.create(sql, {
      hnswM: 8,
      hnswEfConstruction: 32,
      bm25K1: 1.5,
      bm25B: 0.5,
    }),
  ]);
});

afterAll(async () => {
  await Promise.all([canonical?.drop(), dim768?.drop(), customIdx?.drop()]);
  await sql.end();
});

describe("provisionSpace (caller-transaction, transactional DDL)", () => {
  test("rolls back the whole schema when the caller's transaction aborts", async () => {
    const slug = randomSlug();
    const schema = `metest_${slug}`;
    await expect(
      sql.begin(async (tx) => {
        await provisionSpace(tx, { slug, schema, embeddingDimensions: 4 });
        // visible inside the transaction (schema + memory table created)
        const [r] =
          await tx`select to_regclass(${`${schema}.memory`}) is not null as present`;
        expect(r?.present).toBe(true);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    // schema + bm25/hnsw index DDL all rolled back — nothing left behind
    expect(await schemaExists(sql, schema)).toBe(false);
  });

  test("commits a fully-migrated space when the transaction succeeds", async () => {
    const slug = randomSlug();
    const schema = `metest_${slug}`;
    try {
      await sql.begin(async (tx) => {
        await provisionSpace(tx, { slug, schema, embeddingDimensions: 4 });
      });
      expect(await schemaExists(sql, schema)).toBe(true);
      expect(await tableExists(sql, schema, "memory")).toBe(true);
      expect(await getSchemaVersion(sql, schema)).toBe(SPACE_SCHEMA_VERSION);
    } finally {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    }
  });
});

describe("provisioned space schema", () => {
  test("creates the space schema", async () => {
    expect(await schemaExists(sql, canonical.schema)).toBe(true);
  });

  test("creates infrastructure and domain tables", async () => {
    const tables = await listTables(sql, canonical.schema);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
  });

  test("records every incremental migration exactly once", async () => {
    expect(await appliedMigrations(sql, canonical.schema)).toEqual(
      EXPECTED_MIGRATIONS,
    );
  });

  test("stamps the schema version", async () => {
    expect(await getSchemaVersion(sql, canonical.schema)).toBe(
      SPACE_SCHEMA_VERSION,
    );
  });

  test("creates the memory + queue functions", async () => {
    const functions = await listFunctions(sql, canonical.schema);
    for (const fn of [
      ...EXPECTED_MEMORY_FUNCTIONS,
      ...EXPECTED_QUEUE_FUNCTIONS,
    ]) {
      expect(functions).toContain(fn);
    }
  });

  test("creates all memory search indexes", async () => {
    const indexes = await listIndexes(sql, canonical.schema, "memory");
    for (const idx of EXPECTED_MEMORY_INDEXES) {
      expect(indexes).toContain(idx);
    }
  });

  test("memory.embedding defaults to halfvec(1536)", async () => {
    expect(await columnType(sql, canonical.schema, "memory", "embedding")).toBe(
      "halfvec(1536)",
    );
  });

  test("installs the memory update trigger", async () => {
    const triggers = await listTriggers(sql, canonical.schema, "memory");
    expect(triggers).toContain("memory_before_update_trg");
  });
});

describe("migration templating", () => {
  test("applies a custom embedding dimension to the table and search fn", async () => {
    // The template var drives the column type ...
    expect(await columnType(sql, dim768.schema, "memory", "embedding")).toBe(
      "halfvec(768)",
    );
    // ... and is baked into the search function body's vector casts.
    const [row] = await sql.unsafe(
      `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = '${dim768.schema}' and p.proname = 'search_memory'`,
    );
    expect(row?.def).toContain("halfvec(768)");
  });

  test("applies custom HNSW index parameters", async () => {
    const opts = await getIndexReloptions(
      sql,
      customIdx.schema,
      "memory_embedding_hnsw_idx",
    );
    expect(opts).toContain("m=8");
    expect(opts).toContain("ef_construction=32");
  });

  test("applies custom BM25 index parameters", async () => {
    const opts = await getIndexReloptions(
      sql,
      customIdx.schema,
      "memory_content_bm25_idx",
    );
    expect(opts).toContain("k1=1.5");
    expect(opts).toContain("b=0.5");
  });
});

describe("migration behavior", () => {
  test("is idempotent: re-running is safe", async () => {
    await withTestSpace(sql, {}, async (space) => {
      const before = await appliedMigrations(sql, space.schema);
      await migrateSpace(sql, { slug: space.slug, schema: space.schema });
      expect(await appliedMigrations(sql, space.schema)).toEqual(before);
      expect(await getSchemaVersion(sql, space.schema)).toBe(
        SPACE_SCHEMA_VERSION,
      );
    });
  });

  test("rejects a downgrade (db version newer than app)", async () => {
    await withTestSpace(sql, {}, async (space) => {
      await sql.unsafe(`update ${space.schema}.version set version = '99.0.0'`);
      await expect(
        migrateSpace(sql, { slug: space.slug, schema: space.schema }),
      ).rejects.toThrow(/older than database version/);
    });
  });

  test("rejects invalid slugs before touching the database", async () => {
    for (const slug of ["BAD", "short", "way-too-long-slug", "has space12"]) {
      await expect(migrateSpace(sql, { slug })).rejects.toThrow(
        /Invalid space slug/,
      );
    }
  });

  test("provisions distinct spaces independently and in parallel", async () => {
    const [a, b] = await Promise.all([
      TestSpace.create(sql),
      TestSpace.create(sql),
    ]);
    try {
      expect(a.schema).not.toBe(b.schema);
      expect(await schemaExists(sql, a.schema)).toBe(true);
      expect(await schemaExists(sql, b.schema)).toBe(true);
      // Dropping one leaves the other intact.
      await a.drop();
      expect(await schemaExists(sql, a.schema)).toBe(false);
      expect(await schemaExists(sql, b.schema)).toBe(true);
    } finally {
      await a.drop();
      await b.drop();
    }
  });
});

describe("provisioned schema is functional", () => {
  // Shape assertions read the catalog, so sharing `canonical` with these write
  // smoke tests is safe — inserted rows don't affect schema introspection.
  test("accepts a memory and fires the update trigger", async () => {
    const [row] = await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree)
       values ('hello world', 'a.b') returning id, updated_at`,
    );
    expect(row?.id).toBeDefined();
    expect(row?.updated_at).toBeNull();

    const [updated] = await sql.unsafe(
      `update ${canonical.schema}.memory set content = 'changed'
       where id = '${row?.id}' returning updated_at`,
    );
    expect(updated?.updated_at).not.toBeNull();
  });

  test("create_memory skips a duplicate explicit id (returns null)", async () => {
    // Deterministic-id importers re-submit existing ids; the second create
    // must be a no-op that returns null, leaving the original row intact.
    const owner = `'[{"tree_path": "", "access": 3}]'::jsonb`;
    const id = "01941000-0000-7000-8000-000000000001";
    const [first] = await sql.unsafe(
      `select ${canonical.schema}.create_memory(
         ${owner}, 'a.dup'::ltree, 'original', '${id}'::uuid) as id`,
    );
    expect(first?.id).toBe(id);

    const [second] = await sql.unsafe(
      `select ${canonical.schema}.create_memory(
         ${owner}, 'a.dup'::ltree, 'replacement', '${id}'::uuid) as id`,
    );
    expect(second?.id).toBeNull();

    const [row] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.content).toBe("original");
  });

  test("enforces the meta-is-object constraint", async () => {
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.memory (content, meta)
         values ('x', '[]'::jsonb)`,
      ),
    );
  });

  test("enforces the temporal range convention", async () => {
    // A closed [start,end] range with start < end violates the convention
    // (ranges must be inclusive-exclusive); only point-in-time may close upper.
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.memory (content, temporal)
         values ('x', '[2024-01-01, 2024-01-02]'::tstzrange)`,
      ),
    );
  });
});

describe("bootstrapSpaceDatabase", () => {
  test("is idempotent", async () => {
    await bootstrapSpaceDatabase(sql);
    await bootstrapSpaceDatabase(sql);
  });
});
