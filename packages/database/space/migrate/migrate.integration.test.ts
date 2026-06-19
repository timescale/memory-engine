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
  "004_count_tree",
  "005_memory_name",
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
  "resolve_memory_id",
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
  "memory_tree_name_uidx",
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

  test("name: (tree,name) unique, nulls coexist, format enforced", async () => {
    const t = "namecol";
    await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree, name)
       values ('first', '${t}', 'doc')`,
    );
    // Same (tree, name) collides on the partial unique index.
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.memory (content, tree, name)
         values ('second', '${t}', 'doc')`,
      ),
    );
    // The same name under a different tree is fine.
    const [other] = await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree, name)
       values ('elsewhere', '${t}.sub', 'doc') returning id`,
    );
    expect(other?.id).toBeDefined();
    // Any number of unnamed (null) memories coexist under one tree.
    await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree)
       values ('a', '${t}'), ('b', '${t}')`,
    );
    // Filename-like names (dots allowed) pass; leading-dot / spaces rejected.
    await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree, name)
       values ('cfg', '${t}', 'config.yaml')`,
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.memory (content, tree, name)
         values ('bad', '${t}', '.hidden')`,
      ),
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.memory (content, tree, name)
         values ('bad', '${t}', 'has space')`,
      ),
    );
  });

  // create_memory: (treeAccess, tree, content, id, meta, temporal, name,
  // onConflict) → zero rows (skip) or (id, inserted).
  const OWNER = `'[{"tree_path": "", "access": 3}]'::jsonb`;
  const createMemory = (args: string) =>
    sql.unsafe(`select * from ${canonical.schema}.create_memory(${args})`);

  test("count_tree can cap the counted rows", async () => {
    await createMemory(`${OWNER}, 'a.count.one'::ltree, 'one'`);
    await createMemory(`${OWNER}, 'a.count.two'::ltree, 'two'`);
    await createMemory(`${OWNER}, 'a.count.three'::ltree, 'three'`);

    const [full] = await sql.unsafe(
      `select ${canonical.schema}.count_tree(${OWNER}, 'a.count'::ltree, 1) as n`,
    );
    expect(Number(full?.n)).toBe(3);

    const [capped] = await sql.unsafe(
      `select ${canonical.schema}.count_tree(${OWNER}, 'a.count'::ltree, 1, 2) as n`,
    );
    expect(Number(capped?.n)).toBe(2);
  });

  test("create_memory raises on a bare duplicate explicit id", async () => {
    // A conflict on the id key under the default onConflict ('error') is a hard
    // error; importers pass onConflict 'replace' (next test) to stay idempotent.
    const id = "01941000-0000-7000-8000-000000000001";
    const [first] = await createMemory(
      `${OWNER}, 'a.dup'::ltree, 'original', '${id}'::uuid`,
    );
    expect(first?.id).toBe(id);
    expect(first?.inserted).toBe(true);

    await expectReject(() =>
      createMemory(`${OWNER}, 'a.dup'::ltree, 'replacement', '${id}'::uuid`),
    );

    const [row] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.content).toBe("original"); // untouched
  });

  test("create_memory id-keyed 'replace' is content-aware: replaces when a field differs, no-op when identical", async () => {
    const id = "01941000-0000-7000-8000-000000000002";
    await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v1', '${id}'::uuid, '{"v": "1"}'::jsonb`,
    );

    // Identical content+meta → content-aware replace is a no-op (zero rows).
    const same = await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v1', '${id}'::uuid, '{"v": "1"}'::jsonb, null, null, 'replace'`,
    );
    expect(same.length).toBe(0);

    // Meta differs (same content) → replaced in place, inserted = false. This
    // is how an importer_version bump propagates: the version lives in meta.
    const [bumped] = await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v1', '${id}'::uuid, '{"v": "2"}'::jsonb, null, null, 'replace'`,
    );
    expect(bumped?.id).toBe(id);
    expect(bumped?.inserted).toBe(false);

    const [row] = await sql.unsafe(
      `select meta->>'v' as v, updated_at
       from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.v).toBe("2");
    expect(row?.updated_at).not.toBeNull();
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
      `${limited}, 'a.open'::ltree, 'hijack', '${id}'::uuid, '{"v": "2"}'::jsonb, null, null, 'replace'`,
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

    // One call carrying: a stale row (changed content → update), a current row
    // (identical content+meta → skip), a brand new row (insert), and a no-id
    // row (insert with generated id) — all under content-aware 'replace'.
    const rows = await sql.unsafe(
      `select * from ${canonical.schema}.batch_create_memory(
         ${OWNER},
         array['${stale}', '${fresh}', '01941000-0000-7000-8000-00000000b003', null]::uuid[],
         array['a.batch', 'a.batch', 'a.batch', 'a.batch']::ltree[],
         array['new render', 'current', 'added', 'generated']::text[],
         '[{"v": "2"}, {"v": "2"}, {"v": "2"}, {"v": "2"}]'::jsonb,
         array[null, null, null, null]::tstzrange[],
         null,
         'replace'
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
      `${OWNER}, 'a.emb'::ltree, 'stable content', '${id}'::uuid, '{"v": "2"}'::jsonb, null, null, 'replace'`,
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
      `${OWNER}, 'a.emb'::ltree, 'new content', '${id}'::uuid, '{"v": "3"}'::jsonb, null, null, 'replace'`,
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

  // create_memory args: (treeAccess, tree, content, id, meta, temporal, name,
  // onConflict).
  // onConflict: a bare named conflict errors; 'ignore' skips; 'replace' is
  // content-aware (no-op when identical, replaces when something differs).
  test("create_memory onConflict: error | ignore | replace(content-aware)", async () => {
    const [first] = await createMemory(
      `${OWNER}, 'n.dir'::ltree, 'v1', null, '{}'::jsonb, null, 'note'`,
    );
    expect(first?.inserted).toBe(true);
    const id = first?.id;

    // default 'error' → a hard conflict (raise).
    await expectReject(() =>
      createMemory(
        `${OWNER}, 'n.dir'::ltree, 'v2', null, '{}'::jsonb, null, 'note'`,
      ),
    );

    // 'ignore' → skip, existing row untouched.
    const ignored = await createMemory(
      `${OWNER}, 'n.dir'::ltree, 'v2', null, '{}'::jsonb, null, 'note', 'ignore'`,
    );
    expect(ignored.length).toBe(0);
    expect(
      (
        await sql.unsafe(
          `select content from ${canonical.schema}.memory where id = '${id}'`,
        )
      )[0]?.content,
    ).toBe("v1");

    // 'replace' with differing content → replaced in place, same id.
    const [up] = await createMemory(
      `${OWNER}, 'n.dir'::ltree, 'v2', null, '{}'::jsonb, null, 'note', 'replace'`,
    );
    expect(up?.id).toBe(id);
    expect(up?.inserted).toBe(false);

    // 'replace' with identical content/meta → no-op (content-aware), zero rows.
    const noop = await createMemory(
      `${OWNER}, 'n.dir'::ltree, 'v2', null, '{}'::jsonb, null, 'note', 'replace'`,
    );
    expect(noop.length).toBe(0);

    const [row] = await sql.unsafe(
      `select content, name from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.content).toBe("v2");
    expect(row?.name).toBe("note");
  });

  test("create_memory: id-keyed replace applies a tree-only move (not a no-op)", async () => {
    const id = "01941000-0000-7000-8000-0000000000a0";
    await createMemory(`${OWNER}, 'mv.from'::ltree, 'body', '${id}'::uuid`);
    // Same id + content, new tree → content-aware replace must still move it.
    const [moved] = await createMemory(
      `${OWNER}, 'mv.to'::ltree, 'body', '${id}'::uuid, '{}'::jsonb, null, null, 'replace'`,
    );
    expect(moved?.id).toBe(id);
    expect(moved?.inserted).toBe(false);
    const [row] = await sql.unsafe(
      `select tree::text as tree from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.tree).toBe("mv.to");
  });

  test("named create 'replace' is content-aware; a bare batch named collision raises", async () => {
    await createMemory(
      `${OWNER}, 'n.imp'::ltree, 'r1', null, '{"v":"1"}'::jsonb, null, 'doc'`,
    );
    // Identical content+meta → idempotent no-op (no raise, zero rows).
    const same = await createMemory(
      `${OWNER}, 'n.imp'::ltree, 'r1', null, '{"v":"1"}'::jsonb, null, 'doc', 'replace'`,
    );
    expect(same.length).toBe(0);
    // Meta differs (importer-version bump) → replace in place (no raise).
    const [diff] = await createMemory(
      `${OWNER}, 'n.imp'::ltree, 'r1', null, '{"v":"2"}'::jsonb, null, 'doc', 'replace'`,
    );
    expect(diff?.inserted).toBe(false);
    // A batch with a bare (default-error) named collision raises, aborting it.
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.batch_create_memory(
           ${OWNER},
           array[null]::uuid[],
           array['n.imp']::ltree[],
           array['dupe']::text[],
           '[{}]'::jsonb,
           array[null]::tstzrange[],
           array['doc']::text[]
         )`,
      ),
    );
  });

  test("get_memory and resolve_memory_id surface the name", async () => {
    const [m] = await createMemory(
      `${OWNER}, 'n.resolve'::ltree, 'body', null, '{}'::jsonb, null, 'doc'`,
    );
    const [got] = await sql.unsafe(
      `select name from ${canonical.schema}.get_memory(${OWNER}, '${m?.id}'::uuid)`,
    );
    expect(got?.name).toBe("doc");

    const [resolved] = await sql.unsafe(
      `select ${canonical.schema}.resolve_memory_id(${OWNER}, 'n.resolve'::ltree, 'doc') as id`,
    );
    expect(resolved?.id).toBe(m?.id);

    // No read access → null, so a non-reader can't probe existence.
    const [denied] = await sql.unsafe(
      `select ${canonical.schema}.resolve_memory_id('[]'::jsonb, 'n.resolve'::ltree, 'doc') as id`,
    );
    expect(denied?.id).toBeNull();
  });
});

describe("bootstrapSpaceDatabase", () => {
  test("is idempotent", async () => {
    await bootstrapSpaceDatabase(sql);
    await bootstrapSpaceDatabase(sql);
  });
});
