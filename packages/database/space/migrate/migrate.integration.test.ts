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
  "006_content_version",
  "007_memory_version",
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
  "reconcile_tree",
  "resolve_memory_id",
  "search_memory",
  "tree_access",
  "compute_memory_version_hash",
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

  // The 006_content_version migration renamed embedding_version → content_version
  // on both memory and embedding_queue. The old name must be gone (so any stale
  // SQL referencing it fails loudly) and the new name must be present with the
  // original type/default preserved.
  test("memory and embedding_queue use content_version (the embedding_version rename)", async () => {
    expect(
      await columnType(sql, canonical.schema, "memory", "content_version"),
    ).toBe("integer");
    expect(
      await columnType(sql, canonical.schema, "memory", "embedding_version"),
    ).toBeNull();
    expect(
      await columnType(
        sql,
        canonical.schema,
        "embedding_queue",
        "content_version",
      ),
    ).toBe("integer");
    expect(
      await columnType(
        sql,
        canonical.schema,
        "embedding_queue",
        "embedding_version",
      ),
    ).toBeNull();
  });

  test("memory versioning columns are present and backfilled", async () => {
    expect(await columnType(sql, canonical.schema, "memory", "version")).toBe(
      "bigint",
    );
    expect(
      await columnType(sql, canonical.schema, "memory", "version_hash"),
    ).toBe("text");

    const [row] = await sql.unsafe(
      `select count(*)::int as missing
       from ${canonical.schema}.memory
       where version is null or version_hash is null`,
    );
    expect(row?.missing).toBe(0);
  });

  test("installs the memory versioning triggers", async () => {
    const triggers = await listTriggers(sql, canonical.schema, "memory");
    expect(triggers).toContain("memory_before_insert_trg");
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
  test("accepts a memory and fires the update trigger (content change bumps content_version)", async () => {
    const [row] = await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree)
       values ('hello world', 'a.b')
       returning id, updated_at, content_version`,
    );
    expect(row?.id).toBeDefined();
    expect(row?.updated_at).toBeNull();
    expect(row?.content_version).toBe(1);

    // Content change → trigger bumps content_version and clears embedding so
    // the worker re-embeds. A meta-only update must NOT bump the counter.
    const [bumped] = await sql.unsafe(
      `update ${canonical.schema}.memory set content = 'changed'
       where id = '${row?.id}' returning updated_at, content_version`,
    );
    expect(bumped?.updated_at).not.toBeNull();
    expect(bumped?.content_version).toBe(2);

    const [metaOnly] = await sql.unsafe(
      `update ${canonical.schema}.memory set meta = '{"k": "v"}'::jsonb
       where id = '${row?.id}' returning content_version`,
    );
    expect(metaOnly?.content_version).toBe(2);
  });

  test("memory versioning trigger manages version and version_hash", async () => {
    const [row] = await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree, name, meta, temporal)
       values ('versioned body', 'v.hash', 'doc', '{"a": 1}'::jsonb, '[2024-01-01,2024-01-02)'::tstzrange)
       returning id, version, version_hash`,
    );
    expect(row?.id).toBeDefined();
    expect(Number(row?.version)).toBe(1);
    expect(row?.version_hash).toMatch(/^[0-9a-f]{32}$/);

    const originalHash = row?.version_hash;
    const [logical] = await sql.unsafe(
      `update ${canonical.schema}.memory set meta = '{"a": 2}'::jsonb
       where id = '${row?.id}'
       returning version, version_hash`,
    );
    expect(Number(logical?.version)).toBe(2);
    expect(logical?.version_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(logical?.version_hash).not.toBe(originalHash);

    const [manual] = await sql.unsafe(
      `update ${canonical.schema}.memory
       set version = 99, version_hash = 'bad'
       where id = '${row?.id}'
       returning version, version_hash`,
    );
    expect(Number(manual?.version)).toBe(2);
    expect(manual?.version_hash).toBe(logical?.version_hash);
  });

  test("compute_memory_version_hash is stable across datetime rendering settings", async () => {
    const [row] = await sql.unsafe(
      `insert into ${canonical.schema}.memory (content, tree, temporal)
       values ('temporal hash', 'v.temporal', '[2024-01-01 00:00:00+00,2024-01-02 00:00:00+00)'::tstzrange)
       returning id, version_hash`,
    );

    const [otherSettings] = await sql.begin(async (tx) => {
      await tx`set local timezone to 'America/Los_Angeles'`;
      await tx`set local datestyle to 'SQL, DMY'`;
      return tx.unsafe(
        `select ${canonical.schema}.compute_memory_version_hash(m) as hash
         from ${canonical.schema}.memory m
         where m.id = '${row?.id}'`,
      );
    });

    expect(otherSettings?.hash).toBe(row?.version_hash);
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

  test("reconcile_tree deletes stale importer rows; kept/foreign/unnamed survive", async () => {
    // Importer-stamped: one kept slot, one stale slot, one unnamed row.
    // Foreign: same root, different meta stamp — must never be touched.
    await createMemory(
      `${OWNER}, 'a.rec.docs'::ltree, 'kept', null, '{"source":"t"}'::jsonb, null, 'kept.md'`,
    );
    await createMemory(
      `${OWNER}, 'a.rec.docs'::ltree, 'stale', null, '{"source":"t"}'::jsonb, null, 'stale.md'`,
    );
    await createMemory(
      `${OWNER}, 'a.rec.docs'::ltree, 'foreign', null, '{"source":"other"}'::jsonb, null, 'foreign.md'`,
    );
    await createMemory(
      `${OWNER}, 'a.rec.docs'::ltree, 'unnamed', null, '{"source":"t"}'::jsonb`,
    );

    const call = (dryRun: boolean) =>
      sql.unsafe(
        `select * from ${canonical.schema}.reconcile_tree(` +
          `${OWNER}, 'a.rec'::ltree, '{"source":"t"}'::jsonb, ` +
          `array['a.rec.docs']::ltree[], array['kept.md']::text[], ${dryRun})`,
      );

    // Dry run: lists the stale slot, deletes nothing.
    const dry = await call(true);
    expect(dry.map((r) => r.name)).toEqual(["stale.md"]);
    const [before] = await sql.unsafe(
      `select count(*)::int as n from ${canonical.schema}.memory where tree <@ 'a.rec'::ltree`,
    );
    expect(before?.n).toBe(4);

    // Real run: exactly the stale slot goes; kept, foreign, unnamed survive.
    const deleted = await call(false);
    expect(deleted.map((r) => r.name)).toEqual(["stale.md"]);
    const rest = await sql.unsafe(
      `select content from ${canonical.schema}.memory where tree <@ 'a.rec'::ltree order by content`,
    );
    expect(rest.map((r) => r.content)).toEqual(["foreign", "kept", "unnamed"]);
  });

  test("reconcile_tree refuses empty scope, ragged arrays, nulls, weak access", async () => {
    const good = `'{"source":"t"}'::jsonb, array[]::ltree[], array[]::text[], false`;
    // Unscoped reconcile (empty meta) is refused at the SQL layer.
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.reconcile_tree(${OWNER}, 'a.rec2'::ltree, '{}'::jsonb, array[]::ltree[], array[]::text[], false)`,
      ),
    );
    // Ragged keep-list arrays.
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.reconcile_tree(${OWNER}, 'a.rec2'::ltree, '{"source":"t"}'::jsonb, array['a.rec2']::ltree[], array[]::text[], false)`,
      ),
    );
    // Null keep-list entries (a null slot would silently read as "delete").
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.reconcile_tree(${OWNER}, 'a.rec2'::ltree, '{"source":"t"}'::jsonb, array['a.rec2']::ltree[], array[null]::text[], false)`,
      ),
    );
    // Read-only grant: the up-front write gate refuses.
    const reader = `'[{"tree_path": "", "access": 1}]'::jsonb`;
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.reconcile_tree(${reader}, 'a.rec2'::ltree, ${good})`,
      ),
    );
  });

  test("create_memory raises on a bare duplicate explicit id", async () => {
    // A conflict on the id key under the default onConflict ('error') is a hard
    // error; importers pass onConflict 'replace' (next test) to stay idempotent.
    const id = "01941000-0000-7000-8000-000000000001";
    const [first] = await createMemory(
      `${OWNER}, 'a.dup'::ltree, 'original', '${id}'::uuid`,
    );
    expect(first?.id).toBe(id);
    expect(first?.status).toBe("inserted");

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

    // Identical content+meta → content-aware replace is a no-op (skipped).
    const [same] = await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v1', '${id}'::uuid, '{"v": "1"}'::jsonb, null, null, 'replace'`,
    );
    expect(same?.id).toBe(id);
    expect(same?.status).toBe("skipped");

    // Meta differs (same content) → replaced in place (updated). This is how an
    // importer_version bump propagates: the version lives in meta.
    const [bumped] = await createMemory(
      `${OWNER}, 'a.ver'::ltree, 'render v1', '${id}'::uuid, '{"v": "2"}'::jsonb, null, null, 'replace'`,
    );
    expect(bumped?.id).toBe(id);
    expect(bumped?.status).toBe("updated");

    const [row] = await sql.unsafe(
      `select meta->>'v' as v, updated_at
       from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.v).toBe("2");
    expect(row?.updated_at).not.toBeNull();
  });

  test("create_memory explicit-id collision with an unwritable tree: error raises, replace raises, ignore skips", async () => {
    // The row lives under a.secret; the caller's grant covers only a.open, so
    // the INPUT tree (a.open) passes the up-front check while the EXISTING row's
    // tree (a.secret) is unwritable. 'error' raises CONFLICT and 'replace'
    // raises insufficient_privilege (it can't perform the replace) — neither
    // silently skips, which used to surface as INTERNAL_ERROR on read-back.
    // 'ignore' skips, leaving the existing row alone.
    const id = "01941000-0000-7000-8000-000000000003";
    await createMemory(
      `${OWNER}, 'a.secret'::ltree, 'guarded', '${id}'::uuid, '{"v": "1"}'::jsonb`,
    );
    const limited = `'[{"tree_path": "a.open", "access": 3}]'::jsonb`;

    // error (default) → raise.
    await expectReject(() =>
      createMemory(
        `${limited}, 'a.open'::ltree, 'hijack', '${id}'::uuid, '{"v": "2"}'::jsonb`,
      ),
    );
    // replace → raise (can't replace a row in an unwritable tree).
    await expectReject(() =>
      createMemory(
        `${limited}, 'a.open'::ltree, 'hijack', '${id}'::uuid, '{"v": "2"}'::jsonb, null, null, 'replace'`,
      ),
    );
    // ignore → skip, returning the existing stored id.
    const [ignored] = await createMemory(
      `${limited}, 'a.open'::ltree, 'hijack', '${id}'::uuid, '{"v": "2"}'::jsonb, null, null, 'ignore'`,
    );
    expect(ignored?.id).toBe(id);
    expect(ignored?.status).toBe("skipped");

    // The existing row is untouched in every case.
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
      `select ord, id, status from ${canonical.schema}.batch_create_memory(
         ${OWNER},
         array['${stale}', '${fresh}', '01941000-0000-7000-8000-00000000b003', null]::uuid[],
         array['a.batch', 'a.batch', 'a.batch', 'a.batch']::ltree[],
         array['new render', 'current', 'added', 'generated']::text[],
         '[{"v": "2"}, {"v": "2"}, {"v": "2"}, {"v": "2"}]'::jsonb,
         array[null, null, null, null]::tstzrange[],
         null,
         'replace'
       ) order by ord`,
    );
    // One row per input, in order, with a per-row status.
    expect(rows.map((r) => Number(r.ord))).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.status)).toEqual([
      "updated", // stale: content changed
      "skipped", // fresh: identical → content-aware no-op
      "inserted", // b003: brand new
      "inserted", // generated id
    ]);
    // Returned ids map back to the inputs (the explicit ones, and a fresh
    // uuid for the no-id row).
    expect(rows[0]?.id).toBe(stale);
    expect(rows[1]?.id).toBe(fresh);
    expect(rows[2]?.id).toBe("01941000-0000-7000-8000-00000000b003");
    expect(rows[3]?.id).toMatch(/^[0-9a-f-]{36}$/);

    const [updated] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${stale}'`,
    );
    expect(updated?.content).toBe("new render");
    const [skipped] = await sql.unsafe(
      `select content from ${canonical.schema}.memory where id = '${fresh}'`,
    );
    expect(skipped?.content).toBe("current");
  });

  test("batch_create_memory rejects a duplicate explicit id within the batch", async () => {
    const id = "01941000-0000-7000-8000-00000000b010";
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.batch_create_memory(
           ${OWNER},
           array['${id}', '${id}']::uuid[],
           array['a.batchdup', 'a.batchdup']::ltree[],
           array['first', 'second']::text[],
           '[{}, {}]'::jsonb,
           array[null, null]::tstzrange[]
         )`,
      ),
    );
    // Nothing was written — the whole batch is rejected up front.
    const [row] = await sql.unsafe(
      `select count(*)::int as n from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.n).toBe(0);
  });

  test("batch_create_memory rejects a duplicate (tree, name) within the batch", async () => {
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.batch_create_memory(
           ${OWNER},
           array[null, null]::uuid[],
           array['a.bdupname', 'a.bdupname']::ltree[],
           array['first', 'second']::text[],
           '[{}, {}]'::jsonb,
           array[null, null]::tstzrange[],
           array['doc', 'doc']::text[]
         )`,
      ),
    );
  });

  test("batch_create_memory catches an id shared across a named and an unnamed row", async () => {
    // The two rows aren't (tree, name) duplicates and land in different
    // partitions (one keyed on id, one on (tree, name)), but they DO collide on
    // the explicit id — the duplicate-id check must catch it.
    const id = "01941000-0000-7000-8000-00000000b011";
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.batch_create_memory(
           ${OWNER},
           array['${id}', '${id}']::uuid[],
           array['a.bmixed', 'a.bmixed']::ltree[],
           array['by-id', 'by-name']::text[],
           '[{}, {}]'::jsonb,
           array[null, null]::tstzrange[],
           array[null, 'doc']::text[]
         )`,
      ),
    );
  });

  test("batch_create_memory rejects two inputs targeting the same existing row via different keys", async () => {
    // Existing named row at (n.cross, doc) with id X.
    const x = "01941000-0000-7000-8000-00000000e001";
    await createMemory(
      `${OWNER}, 'n.cross'::ltree, 'v1', '${x}'::uuid, '{}'::jsonb, null, 'doc'`,
    );

    // input1 {id: X} (unnamed, id-keyed) and input2 {n.cross, doc} (name-keyed)
    // both resolve to the SAME stored row X — distinct keys, so the per-key dup
    // checks miss it; the cross-key check must reject it (else one write would
    // attribute a status to both inputs).
    await expectReject(() =>
      sql.unsafe(
        `select * from ${canonical.schema}.batch_create_memory(
           ${OWNER},
           array['${x}', null]::uuid[],
           array['n.cross', 'n.cross']::ltree[],
           array['by-id', 'by-name']::text[],
           '[{}, {}]'::jsonb,
           array[null, null]::tstzrange[],
           array[null, 'doc']::text[],
           'replace'
         )`,
      ),
    );

    // A single NAMED input whose explicit id equals its own stored id is fine
    // (name wins; not a cross-key collision) — identical content+meta → skip.
    const [same] = await sql.unsafe(
      `select ord, id, status from ${canonical.schema}.batch_create_memory(
         ${OWNER},
         array['${x}']::uuid[],
         array['n.cross']::ltree[],
         array['v1']::text[],
         '[{}]'::jsonb,
         array[null]::tstzrange[],
         array['doc']::text[],
         'replace'
       )`,
    );
    expect(same?.id).toBe(x);
    expect(same?.status).toBe("skipped");
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
    expect(first?.status).toBe("inserted");
    const id = first?.id;

    // default 'error' → a hard conflict (raise).
    await expectReject(() =>
      createMemory(
        `${OWNER}, 'n.dir'::ltree, 'v2', null, '{}'::jsonb, null, 'note'`,
      ),
    );

    // 'ignore' → skip (status 'skipped', existing id), existing row untouched.
    const [ignored] = await createMemory(
      `${OWNER}, 'n.dir'::ltree, 'v2', null, '{}'::jsonb, null, 'note', 'ignore'`,
    );
    expect(ignored?.id).toBe(id);
    expect(ignored?.status).toBe("skipped");
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
    expect(up?.status).toBe("updated");

    // 'replace' with identical content/meta → no-op (content-aware, skipped).
    const [noop] = await createMemory(
      `${OWNER}, 'n.dir'::ltree, 'v2', null, '{}'::jsonb, null, 'note', 'replace'`,
    );
    expect(noop?.id).toBe(id);
    expect(noop?.status).toBe("skipped");

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
    expect(moved?.status).toBe("updated");
    const [row] = await sql.unsafe(
      `select tree::text as tree from ${canonical.schema}.memory where id = '${id}'`,
    );
    expect(row?.tree).toBe("mv.to");
  });

  test("named create 'replace' is content-aware; a bare batch named collision raises", async () => {
    await createMemory(
      `${OWNER}, 'n.imp'::ltree, 'r1', null, '{"v":"1"}'::jsonb, null, 'doc'`,
    );
    // Identical content+meta → idempotent no-op (no raise, status 'skipped').
    const [same] = await createMemory(
      `${OWNER}, 'n.imp'::ltree, 'r1', null, '{"v":"1"}'::jsonb, null, 'doc', 'replace'`,
    );
    expect(same?.status).toBe("skipped");
    // Meta differs (importer-version bump) → replace in place (no raise).
    const [diff] = await createMemory(
      `${OWNER}, 'n.imp'::ltree, 'r1', null, '{"v":"2"}'::jsonb, null, 'doc', 'replace'`,
    );
    expect(diff?.status).toBe("updated");
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

  test("a named row dedups on (tree, name) even with an explicit id (name wins)", async () => {
    // First insert carries an explicit id — used as the row's identity.
    const id1 = "01941000-0000-7000-8000-00000000d101";
    const [first] = await createMemory(
      `${OWNER}, 'n.idname'::ltree, 'v1', '${id1}'::uuid, '{}'::jsonb, null, 'doc'`,
    );
    expect(first?.id).toBe(id1);
    expect(first?.status).toBe("inserted");

    // Re-submit the SAME (tree, name) with a DIFFERENT explicit id + 'replace'.
    // Dedup is on (tree, name), so it replaces in place and KEEPS id1 — the new
    // id is ignored (name wins over id).
    const id2 = "01941000-0000-7000-8000-00000000d102";
    const [second] = await createMemory(
      `${OWNER}, 'n.idname'::ltree, 'v2', '${id2}'::uuid, '{}'::jsonb, null, 'doc', 'replace'`,
    );
    expect(second?.id).toBe(id1); // not id2
    expect(second?.status).toBe("updated");

    const [row] = await sql.unsafe(
      `select id, content from ${canonical.schema}.memory
       where tree = 'n.idname' and name = 'doc'`,
    );
    expect(row?.id).toBe(id1);
    expect(row?.content).toBe("v2");
    // id2 was never inserted.
    const [ghost] = await sql.unsafe(
      `select count(*)::int as n from ${canonical.schema}.memory where id = '${id2}'`,
    );
    expect(ghost?.n).toBe(0);
  });

  test("patch_memory requires the current version_hash and advances version", async () => {
    const [m] = await createMemory(
      `${OWNER}, 'v.patch'::ltree, 'before', null, '{"v": 1}'::jsonb, null, 'doc'`,
    );
    const [before] = await sql.unsafe(
      `select content, version, version_hash
       from ${canonical.schema}.memory
       where id = '${m?.id}'`,
    );
    expect(Number(before?.version)).toBe(1);
    expect(before?.version_hash).toMatch(/^[0-9a-f]{32}$/);

    const [patched] = await sql.unsafe(
      `select ${canonical.schema}.patch_memory(
         ${OWNER},
         '${m?.id}'::uuid,
         '${before?.version_hash}',
         '{"content": "after"}'::jsonb
       ) as ok`,
    );
    expect(patched?.ok).toBe(true);

    const [after] = await sql.unsafe(
      `select content, version, version_hash
       from ${canonical.schema}.memory
       where id = '${m?.id}'`,
    );
    expect(after?.content).toBe("after");
    expect(Number(after?.version)).toBe(2);
    expect(after?.version_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(after?.version_hash).not.toBe(before?.version_hash);

    let code: string | undefined;
    try {
      await sql.unsafe(
        `select ${canonical.schema}.patch_memory(
           ${OWNER},
           '${m?.id}'::uuid,
           '${before?.version_hash}',
           '{"content": "stale overwrite"}'::jsonb
         )`,
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("ME002");

    const [unchanged] = await sql.unsafe(
      `select content, version, version_hash
       from ${canonical.schema}.memory
       where id = '${m?.id}'`,
    );
    expect(unchanged?.content).toBe("after");
    expect(Number(unchanged?.version)).toBe(2);
    expect(unchanged?.version_hash).toBe(after?.version_hash);
  });

  test("get_memory, search_memory, and hybrid_search_memory surface version fields", async () => {
    const [m] = await createMemory(
      `${OWNER}, 'v.returned'::ltree, 'returned fields body', null, '{}'::jsonb, null, 'doc'`,
    );
    await sql.unsafe(
      `update ${canonical.schema}.memory
       set embedding = ('[' || repeat('0,', 1535) || '0]')::halfvec
       where id = '${m?.id}'`,
    );

    const [got] = await sql.unsafe(
      `select version, version_hash
       from ${canonical.schema}.get_memory(${OWNER}, '${m?.id}'::uuid)`,
    );
    expect(Number(got?.version)).toBe(1);
    expect(got?.version_hash).toMatch(/^[0-9a-f]{32}$/);

    const [searched] = await sql.unsafe(
      `select version, version_hash
       from ${canonical.schema}.search_memory(
         ${OWNER},
         null::bm25query,
         null::halfvec,
         null,
         'v.returned'::ltree,
         null,
         null,
         null,
         null,
         null,
         null,
         null,
         null,
         10,
         'desc'
       )
       where id = '${m?.id}'`,
    );
    expect(Number(searched?.version)).toBe(1);
    expect(searched?.version_hash).toBe(got?.version_hash);

    const [hybrid] = await sql.unsafe(
      `select version, version_hash
       from ${canonical.schema}.hybrid_search_memory(
         ${OWNER},
         to_bm25query('returned', '${canonical.schema}.memory_content_bm25_idx'),
         ('[' || repeat('0,', 1535) || '0]')::halfvec,
         null,
         'v.returned'::ltree,
         null,
         null,
         null,
         null,
         null,
         null,
         null,
         null,
         60.0,
         10,
         1.0,
         1.0,
         10
       )
       where id = '${m?.id}'`,
    );
    expect(Number(hybrid?.version)).toBe(1);
    expect(hybrid?.version_hash).toBe(got?.version_hash);
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
