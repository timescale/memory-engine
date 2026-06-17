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
  getIndexDef,
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

const EXPECTED_MIGRATIONS = [
  "001_memory",
  "002_embedding_queue",
  "003_embedding_fk_idx",
];

const EXPECTED_MEMORY_FUNCTIONS = [
  "batch_create_memory",
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

  test("creates the embedding queue memory_id index", async () => {
    const indexes = await listIndexes(sql, canonical.schema, "embedding_queue");
    expect(indexes).toContain("embedding_queue_memory_id_idx");

    const def = await getIndexDef(
      sql,
      canonical.schema,
      "embedding_queue_memory_id_idx",
    );
    expect(def).toContain("(memory_id)");
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

  // create_memory's conditional upsert: (treeAccess, tree, content, id, meta,
  // temporal, replaceIfMetaDiffers) → zero rows (skip) or (id, inserted).
  const OWNER = `'[{"tree_path": "", "access": 3}]'::jsonb`;
  const createMemory = (args: string) =>
    sql.unsafe(`select * from ${canonical.schema}.create_memory(${args})`);

  test("create_memory skips a duplicate explicit id by default", async () => {
    // Deterministic-id importers re-submit existing ids; with no replace key
    // the second create must be a zero-row no-op leaving the row intact.
    const id = "01941000-0000-7000-8000-000000000001";
    const [first] = await createMemory(
      `${OWNER}, 'a.dup'::ltree, 'original', '${id}'::uuid`,
    );
    expect(first?.id).toBe(id);
    expect(first?.inserted).toBe(true);

    const second = await createMemory(
      `${OWNER}, 'a.dup'::ltree, 'replacement', '${id}'::uuid`,
    );
    expect(second.length).toBe(0);

    const [row] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.content).toBe("original");
  });

  test("create_memory replaces a duplicate when the meta key differs, skips when it matches", async () => {
    const id = "01941000-0000-7000-8000-000000000002";
    await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v1', '${id}'::uuid, '{"v": "1"}'::jsonb`,
    );

    // Same version → skip, content untouched.
    const same = await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v1 again', '${id}'::uuid, '{"v": "1"}'::jsonb, null, 'v'`,
    );
    expect(same.length).toBe(0);

    // Bumped version → replaced in place, inserted = false.
    const [bumped] = await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v2', '${id}'::uuid, '{"v": "2"}'::jsonb, null, 'v'`,
    );
    expect(bumped?.id).toBe(id);
    expect(bumped?.inserted).toBe(false);

    const [row] = await sql.unsafe(
      `select content, meta->>'v' as v, updated_at
       from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.content).toBe("render v2");
    expect(row?.v).toBe("2");
    expect(row?.updated_at).not.toBeNull();

    // A key absent on the stored row but present on the new record counts as
    // "differs" (legacy rows written before the version key existed).
    const [legacy] = await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v3', '${id}'::uuid, '{"v": "2", "legacy_v": "1"}'::jsonb, null, 'legacy_v'`,
    );
    expect(legacy?.inserted).toBe(false);
    const [afterLegacy] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(afterLegacy?.content).toBe("render v3");
  });

  test("create_memory replace requires write access on the existing row's tree", async () => {
    // Row lives under a.secret; the caller's grant covers only a.open — the
    // insert-arm check passes (target a.open) but the replace arm must skip.
    const id = "01941000-0000-7000-8000-000000000003";
    await createMemory(
      `${OWNER}, 'a.secret'::ltree, 'guarded', '${id}'::uuid, '{"v": "1"}'::jsonb`,
    );

    const limited = `'[{"tree_path": "a.open", "access": 3}]'::jsonb`;
    const res = await createMemory(
      `${limited}, 'a.open'::ltree, 'hijack', '${id}'::uuid, '{"v": "2"}'::jsonb, null, 'v'`,
    );
    expect(res.length).toBe(0);

    const [row] = await sql.unsafe(
      `select content, tree::text as tree from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.content).toBe("guarded");
    expect(row?.tree).toBe("a.secret");
  });

  test("batch_create_memory upserts a whole batch in one statement", async () => {
    const stale = "01941000-0000-7000-8000-00000000b001";
    const fresh = "01941000-0000-7000-8000-00000000b002";
    await createMemory(
      `${OWNER}, 'a.batch'::ltree, 'old render', '${stale}'::uuid, '{"v": "1"}'::jsonb`,
    );
    await createMemory(
      `${OWNER}, 'a.batch'::ltree, 'current', '${fresh}'::uuid, '{"v": "2"}'::jsonb`,
    );

    // One call carrying: a stale row (update), a current row (skip), a brand
    // new row (insert), and a no-id row (insert with generated id).
    const rows = await sql.unsafe(
      `select * from ${canonical.schema}.batch_create_memory(
         ${OWNER},
         array['${stale}', '${fresh}', '01941000-0000-7000-8000-00000000b003', null]::uuid[],
         array['a.batch', 'a.batch', 'a.batch', 'a.batch']::ltree[],
         array['new render', 'untouched', 'added', 'generated']::text[],
         '[{"v": "2"}, {"v": "2"}, {"v": "2"}, {"v": "2"}]'::jsonb,
         array[null, null, null, null]::tstzrange[],
         'v'
       )`,
    );
    const byId = new Map(rows.map((r) => [r.id as string, r.inserted]));
    expect(byId.get(stale)).toBe(false); // replaced
    expect(byId.has(fresh)).toBe(false); // skipped → absent
    expect(byId.get("01941000-0000-7000-8000-00000000b003")).toBe(true);
    expect(rows).toHaveLength(3); // 2 inserts + 1 update

    const [updated] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${stale}'`,
    );
    expect(updated?.content).toBe("new render");
    const [skipped] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${fresh}'`,
    );
    expect(skipped?.content).toBe("current");
  });

  test("batch_create_memory collapses an id repeated within the batch (first wins)", async () => {
    const id = "01941000-0000-7000-8000-00000000b010";
    const rows = await sql.unsafe(
      `select * from ${canonical.schema}.batch_create_memory(
         ${OWNER},
         array['${id}', '${id}']::uuid[],
         array['a.batchdup', 'a.batchdup']::ltree[],
         array['first', 'second']::text[],
         '[{}, {}]'::jsonb,
         array[null, null]::tstzrange[]
       )`,
    );
    expect(rows).toHaveLength(1);
    const [row] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.content).toBe("first");
  });

  test("batch_create_memory rejects misaligned arrays and bad target access", async () => {
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.batch_create_memory(
           ${OWNER},
           array[null]::uuid[],
           array['a.x', 'a.y']::ltree[],
           array['one']::text[],
           '[{}]'::jsonb,
           array[null]::tstzrange[]
         )`,
      ),
    );

    // One row outside the grant fails the whole batch before any write.
    const limited = `'[{"tree_path": "a.open", "access": 3}]'::jsonb`;
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.batch_create_memory(
           ${limited},
           array[null, null]::uuid[],
           array['a.open', 'a.secret']::ltree[],
           array['ok', 'denied']::text[],
           '[{}, {}]'::jsonb,
           array[null, null]::tstzrange[]
         )`,
      ),
    );
    const [count] = await sql.unsafe(
      `select count(*)::int as n from ${canonical.schema}.memory
       where content in ('ok', 'denied')`,
    );
    expect(count?.n).toBe(0);
  });

  test("create_memory replace re-embeds only when content changed", async () => {
    const id = "01941000-0000-7000-8000-000000000004";
    await createMemory(
      `${OWNER}, 'a.emb'::ltree, 'stable content', '${id}'::uuid, '{"v": "1"}'::jsonb`,
    );
    // Simulate the worker: embedding present (default 1536 dims), queue drained.
    await sql.unsafe(
      `update ${canonical.schema}.memory
       set embedding = ('[' || repeat('0,', 1535) || '0]')::halfvec
       where id = '${id}'`,
    );
    await sql.unsafe(
      `delete from ${canonical.schema}.embedding_queue where memory_id = '${id}'`,
    );

    // Meta-only replace (identical content): embedding survives, no re-enqueue.
    await createMemory(
      `${OWNER}, 'a.emb'::ltree, 'stable content', '${id}'::uuid, '{"v": "2"}'::jsonb, null, 'v'`,
    );
    const [afterMeta] = await sql.unsafe(
      `select (embedding is not null) as has_embedding,
              (select count(*)::int from ${canonical.schema}.embedding_queue
               where memory_id = '${id}' and outcome is null) as queued
       from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(afterMeta?.has_embedding).toBe(true);
    expect(afterMeta?.queued).toBe(0);

    // Content replace: embedding invalidated and re-enqueued.
    await createMemory(
      `${OWNER}, 'a.emb'::ltree, 'new content', '${id}'::uuid, '{"v": "3"}'::jsonb, null, 'v'`,
    );
    const [afterContent] = await sql.unsafe(
      `select (embedding is null) as embedding_cleared,
              (select count(*)::int from ${canonical.schema}.embedding_queue
               where memory_id = '${id}' and outcome is null) as queued
       from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(afterContent?.embedding_cleared).toBe(true);
    expect(afterContent?.queued).toBe(1);
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
