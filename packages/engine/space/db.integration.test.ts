// Integration tests for the space data-plane TS layer (spaceStore).
//
// Provisions a throwaway metest_<slug> schema via migrateSpace (small embedding
// dims for speed) and exercises the wrappers against the real SQL functions.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 packages/engine/space/db.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrateSpace } from "@memory.build/database";
import postgres, { type Sql } from "postgres";
import { type SpaceStore, spaceStore } from "./db";
import type { TreeAccess } from "./types";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomSlug = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 36];
  return s;
};

// Full owner access at "work"; all test memories live under work.*
const FULL: TreeAccess = [{ tree_path: "work", access: 3 }];
const READONLY: TreeAccess = [{ tree_path: "work", access: 1 }];

let sql: Sql;
let schema: string;
let db: SpaceStore;

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  const slug = randomSlug();
  schema = `metest_${slug}`;
  await migrateSpace(sql, { slug, schema, embeddingDimensions: 4 });
  db = spaceStore(sql, schema);
});

afterAll(async () => {
  if (schema) await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.end();
});

/** Directly set a memory's embedding (simulating the worker). */
async function setEmbedding(id: string, vec: number[]): Promise<void> {
  await sql.unsafe(
    `update ${schema}.memory set embedding = $1::halfvec where id = $2`,
    [`[${vec.join(",")}]`, id],
  );
}

/** createMemory asserting a fresh insert happened (no skip/replace). */
async function mustCreate(
  access: TreeAccess,
  params: Parameters<SpaceStore["createMemory"]>[1],
): Promise<string> {
  const created = await db.createMemory(access, params);
  if (created.status !== "inserted") {
    throw new Error(`unexpected status: ${created.status}`);
  }
  return created.id;
}

test("createMemory + getMemory round-trips", async () => {
  const id = await mustCreate(FULL, {
    tree: "work.note",
    content: "hello world",
    meta: { kind: "note" },
  });
  const m = await db.getMemory(FULL, id);
  expect(m?.id).toBe(id);
  expect(m?.tree).toBe("work.note");
  expect(m?.content).toBe("hello world");
  expect(m?.meta).toEqual({ kind: "note" });
  expect(m?.hasEmbedding).toBe(false);
  expect(m?.name).toBeNull();
});

test("name: create / getMemory / resolveMemoryId; onConflict ignore skips", async () => {
  const id = await mustCreate(FULL, {
    tree: "work.named",
    content: "body",
    name: "doc.md",
  });
  expect((await db.getMemory(FULL, id))?.name).toBe("doc.md");
  expect(await db.resolveMemoryId(FULL, "work.named", "doc.md")).toBe(id);
  expect(await db.resolveMemoryId(FULL, "work.named", "missing")).toBeNull();
  // resolve is read-gated (level 1), so readonly access still resolves.
  expect(await db.resolveMemoryId(READONLY, "work.named", "doc.md")).toBe(id);

  // A bare (tree, name) collision raises; onConflict 'ignore' skips it.
  await expect(
    db.createMemory(FULL, { tree: "work.named", content: "x", name: "doc.md" }),
  ).rejects.toThrow();
  const skipped = await db.createMemory(FULL, {
    tree: "work.named",
    content: "x",
    name: "doc.md",
    onConflict: "ignore",
  });
  // Skip still reports the existing row's id so the caller can read it back.
  expect(skipped).toEqual({ id, status: "skipped" });
  expect((await db.getMemory(FULL, id))?.content).toBe("body"); // untouched
});

test("createMemory raises on a bare duplicate explicit id", async () => {
  const id = "01900000-0000-7000-8000-0000000000d0";
  const first = await db.createMemory(FULL, {
    id,
    tree: "work.dup",
    content: "original",
  });
  expect(first).toEqual({ id, status: "inserted" });

  // Re-submitting the same id with no upsert / replace key is a hard conflict.
  await expect(
    db.createMemory(FULL, {
      id,
      tree: "work.dup",
      content: "replacement",
    }),
  ).rejects.toThrow();
  expect((await db.getMemory(FULL, id))?.content).toBe("original");
});

test("createMemory onConflict 'replace' rewrites only when a field differs", async () => {
  const id = "01900000-0000-7000-8000-0000000000d1";
  await db.createMemory(FULL, {
    id,
    tree: "work.upsert",
    content: "render v1",
    meta: { importer_version: "1" },
  });

  // Identical re-submit → content-aware replace is a no-op (skipped).
  const same = await db.createMemory(FULL, {
    id,
    tree: "work.upsert",
    content: "render v1",
    meta: { importer_version: "1" },
    onConflict: "replace",
  });
  expect(same).toEqual({ id, status: "skipped" });
  expect((await db.getMemory(FULL, id))?.content).toBe("render v1");

  // Bumped version re-render → meta + content differ → replaced, reported as an
  // update. The importer_version stamp drives this via meta.
  const bumped = await db.createMemory(FULL, {
    id,
    tree: "work.upsert",
    content: "render v2",
    meta: { importer_version: "2" },
    onConflict: "replace",
  });
  expect(bumped).toEqual({ id, status: "updated" });
  const after = await db.getMemory(FULL, id);
  expect(after?.content).toBe("render v2");
  expect(after?.meta).toEqual({ importer_version: "2" });
});

test("batchCreateMemories upserts a batch in one call", async () => {
  const stale = "01900000-0000-7000-8000-0000000000b1";
  const fresh = "01900000-0000-7000-8000-0000000000b2";
  await db.batchCreateMemories(FULL, [
    { id: stale, tree: "work.batch", content: "old", meta: { v: "1" } },
    { id: fresh, tree: "work.batch", content: "current", meta: { v: "2" } },
  ]);

  const rows = await db.batchCreateMemories(
    FULL,
    [
      // changed content → replaced
      { id: stale, tree: "work.batch", content: "new", meta: { v: "2" } },
      // identical content+meta → content-aware replace no-op (skipped)
      { id: fresh, tree: "work.batch", content: "current", meta: { v: "2" } },
      { tree: "work.batch", content: "generated id" },
    ],
    "replace",
  );
  // One row per input, in input order, each with a status.
  expect(rows.map((r) => r.status)).toEqual(["updated", "skipped", "inserted"]);
  expect(rows[0]?.id).toBe(stale);
  expect(rows[1]?.id).toBe(fresh);
  expect((await db.getMemory(FULL, stale))?.content).toBe("new");
  expect((await db.getMemory(FULL, fresh))?.content).toBe("current");
  const generated = rows[2];
  expect((await db.getMemory(FULL, generated?.id as string))?.content).toBe(
    "generated id",
  );
});

test("access is enforced by the tree_access argument", async () => {
  // create requires write (>=2): read-only access is rejected
  await expect(
    db.createMemory(READONLY, { tree: "work.x", content: "nope" }),
  ).rejects.toThrow();

  // a memory is invisible to a tree_access set that doesn't cover its path
  const id = await mustCreate(FULL, {
    tree: "work.secret",
    content: "shh",
  });
  const other: TreeAccess = [{ tree_path: "other", access: 3 }];
  expect(await db.getMemory(other, id)).toBeNull();
});

test("patchMemory updates fields; deleteMemory removes", async () => {
  const id = await mustCreate(FULL, {
    tree: "work.p",
    content: "before",
  });
  const before = await db.getMemory(FULL, id);
  expect(before?.version).toBe(1);
  expect(before?.versionHash).toMatch(/^[0-9a-f]{32}$/);

  expect(
    await db.patchMemory(FULL, id, before?.versionHash as string, {
      content: "after",
    }),
  ).toBe(true);
  const after = await db.getMemory(FULL, id);
  expect(after?.content).toBe("after");
  expect(after?.version).toBe(2);
  expect(after?.versionHash).not.toBe(before?.versionHash);

  expect(await db.deleteMemory(FULL, id)).toBe(true);
  expect(await db.getMemory(FULL, id)).toBeNull();
});

test("bm25 search ranks by full-text relevance", async () => {
  await db.createMemory(FULL, {
    tree: "work.a",
    content: "the quick brown fox",
  });
  await db.createMemory(FULL, { tree: "work.b", content: "lorem ipsum dolor" });

  const results = await db.search(FULL, { bm25: "fox", limit: 5 });
  expect(results.length).toBeGreaterThanOrEqual(1);
  expect(results[0]?.content).toContain("fox");
});

test("unranked (filter-only) search orders by id, newest-first by default", async () => {
  // Explicit, strictly-increasing uuidv7 ids under a dedicated subtree.
  const ids = [
    "01900000-0000-7000-8000-000000000001",
    "01900000-0000-7000-8000-000000000002",
    "01900000-0000-7000-8000-000000000003",
  ];
  for (const id of ids) {
    await db.createMemory(FULL, { id, tree: "work.ord", content: `c-${id}` });
  }

  // Default → newest id first (desc); results[0] is the high-water entry.
  const def = await db.search(FULL, { ltree: "work.ord", limit: 10 });
  expect(def.map((r) => r.id)).toEqual([...ids].reverse());

  // Explicit asc → oldest first.
  const asc = await db.search(FULL, {
    ltree: "work.ord",
    order: "asc",
    limit: 10,
  });
  expect(asc.map((r) => r.id)).toEqual(ids);

  // Explicit desc matches the default.
  const desc = await db.search(FULL, {
    ltree: "work.ord",
    order: "desc",
    limit: 10,
  });
  expect(desc.map((r) => r.id)).toEqual([...ids].reverse());
});

test("temporal filters are conjunctive, including contains and overlaps", async () => {
  const target = await mustCreate(FULL, {
    tree: "work.temporal.target",
    content: "temporal target",
    temporal: "[2026-01-10T00:00:00Z,2026-01-20T00:00:00Z)",
  });
  await mustCreate(FULL, {
    tree: "work.temporal.decoy",
    content: "temporal decoy",
    temporal: "[2026-01-10T00:00:00Z,2026-01-15T00:00:00Z)",
  });
  await setEmbedding(target, [0, 0, 0, 1]);

  const filters = {
    temporalAfter: "2026-01-05T00:00:00Z",
    temporalBefore: "2026-01-25T00:00:00Z",
    temporalContains: "2026-01-14T00:00:00Z",
    temporalOverlaps: "[2026-01-15T00:00:00Z,2026-01-25T00:00:00Z)",
    temporalWithin: "[2026-01-01T00:00:00Z,2026-02-01T00:00:00Z)",
  };
  expect(
    (await db.search(FULL, { ...filters, limit: 10 })).map((r) => r.id),
  ).toEqual([target]);
  expect(
    (
      await db.hybridSearch(FULL, {
        ...filters,
        bm25: "target",
        vec: [0, 0, 0, 1],
        limit: 10,
      })
    ).map((r) => r.id),
  ).toEqual([target]);
});

test("vector search ranks by embedding similarity and returns cosine similarity as score", async () => {
  const near = await mustCreate(FULL, {
    tree: "work.v1",
    content: "near",
  });
  const far = await mustCreate(FULL, { tree: "work.v2", content: "far" });
  await setEmbedding(near, [1, 0, 0, 0]); // identical direction → similarity 1
  await setEmbedding(far, [0, 1, 0, 0]); // orthogonal → similarity 0

  const results = await db.search(FULL, { vec: [1, 0, 0, 0], limit: 5 });
  expect(results[0]?.id).toBe(near);

  // Score is cosine similarity (1 - cosine distance), in [-1, 1] — NOT negative
  // distance. Identical vectors → ~1, orthogonal → ~0.
  const byId = new Map(results.map((r) => [r.id, r.score]));
  expect(byId.get(near)).toBeCloseTo(1, 5);
  expect(byId.get(far)).toBeCloseTo(0, 5);
});

test("minSimilarity drops below-threshold vectors, preserving rank order", async () => {
  const near = await mustCreate(FULL, { tree: "work.ms1", content: "near" });
  const mid = await mustCreate(FULL, { tree: "work.ms2", content: "mid" });
  const far = await mustCreate(FULL, { tree: "work.ms3", content: "far" });
  await setEmbedding(near, [1, 0, 0, 0]); // similarity 1 to query
  await setEmbedding(mid, [1, 1, 0, 0]); // similarity ~0.7071 to query
  await setEmbedding(far, [0, 1, 0, 0]); // similarity 0 to query

  // minSimilarity is a cosine-similarity floor (converted to a max-distance
  // bound in SQL). 0.5 keeps near (1) and mid (~0.71), drops far (0). Rank
  // order (near before mid) is preserved.
  const results = await db.search(FULL, {
    vec: [1, 0, 0, 0],
    minSimilarity: 0.5,
    limit: 5,
  });
  const ids = results.map((r) => r.id);
  expect(ids).toContain(near);
  expect(ids).toContain(mid);
  expect(ids).not.toContain(far);
  expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(mid));
});

test("minSimilarity outside [0,1] is rejected, not clamped", async () => {
  const q = [1, 0, 0, 0];
  await expect(db.search(FULL, { vec: q, minSimilarity: 1.5 })).rejects.toThrow(
    /_min_similarity must be between 0 and 1/,
  );
  await expect(
    db.search(FULL, { vec: q, minSimilarity: -0.1 }),
  ).rejects.toThrow(/_min_similarity must be between 0 and 1/);
});

test("hybridSearch fuses bm25 + vector", async () => {
  const id = await mustCreate(FULL, {
    tree: "work.h",
    content: "hybrid pineapple",
  });
  await setEmbedding(id, [0, 0, 1, 0]);

  const results = await db.hybridSearch(FULL, {
    bm25: "pineapple",
    vec: [0, 0, 1, 0],
    limit: 5,
  });
  expect(results.some((r) => r.id === id)).toBe(true);
});

test("bm25 search returns only genuine matches, never zero-score non-matches", async () => {
  // Two docs contain the term; eight do not. With limit > matches, the old
  // `ORDER BY <@> LIMIT` backfilled the result with zero-score non-matches
  // (on both the BMW index path and a seq-scan). The BM25 > 0 invariant drops
  // them: we expect exactly the two real matches, all with a positive score.
  // Use a term unique to this test — the schema is shared across tests, so a
  // common word (e.g. "pineapple", used elsewhere) would pull in other rows.
  const a = await mustCreate(FULL, {
    tree: "work.bm.a",
    content: "dragonfruit smoothie",
  });
  const b = await mustCreate(FULL, {
    tree: "work.bm.b",
    content: "fresh dragonfruit cake",
  });
  for (let i = 0; i < 8; i++) {
    await mustCreate(FULL, {
      tree: `work.bm.x${i}`,
      content: `banana muffin ${i}`,
    });
  }

  const results = await db.search(FULL, { bm25: "dragonfruit", limit: 10 });
  const ids = results.map((r) => r.id).sort();
  expect(ids).toEqual([a, b].sort());
  expect(results.every((r) => r.score > 0)).toBe(true);
});

test("bm25 search with no matching terms returns zero rows", async () => {
  await mustCreate(FULL, { tree: "work.bmz.a", content: "apricot jam" });
  await mustCreate(FULL, { tree: "work.bmz.b", content: "cherry pie" });
  const results = await db.search(FULL, {
    bm25: "zzznonexistentterm",
    limit: 10,
  });
  expect(results).toEqual([]);
});

test("moveTree, countTree, listTree", async () => {
  await db.createMemory(FULL, { tree: "work.src.one", content: "1" });
  await db.createMemory(FULL, { tree: "work.src.two", content: "2" });

  expect(await db.countTree(FULL, { tree: "work.src" }, 1)).toBe(2);
  expect(await db.countTree(FULL, { tree: "work.src" }, 1, 1)).toBe(1);

  const moved = await db.moveTree(FULL, "work.src", "work.dst");
  expect(moved).toBe(2);
  expect(await db.countTree(FULL, { tree: "work.src" }, 1)).toBe(0);
  expect(await db.countTree(FULL, { tree: "work.dst" }, 1)).toBe(2);

  const listed = await db.listTree(FULL, "work.dst.*");
  expect(listed.some((e) => e.tree === "work.dst")).toBe(true);
});

test("copyTree copies a subtree without removing the source", async () => {
  await db.createMemory(FULL, { tree: "work.copy_src.one", content: "1" });
  await db.createMemory(FULL, { tree: "work.copy_src.two", content: "2" });

  const dry = await db.copyTree(FULL, "work.copy_src", "work.copy_dst", true);
  expect(dry).toBe(2);
  expect(await db.countTree(FULL, { tree: "work.copy_src" }, 1)).toBe(2);
  expect(await db.countTree(FULL, { tree: "work.copy_dst" }, 1)).toBe(0);

  const copied = await db.copyTree(FULL, "work.copy_src", "work.copy_dst");
  expect(copied).toBe(2);
  expect(await db.countTree(FULL, { tree: "work.copy_src" }, 1)).toBe(2);
  expect(await db.countTree(FULL, { tree: "work.copy_dst" }, 1)).toBe(2);
});

test("copyTree preserves the name on copied memories", async () => {
  await db.createMemory(FULL, {
    tree: "work.cpname_src",
    name: "doc.md",
    content: "named",
  });

  await db.copyTree(FULL, "work.cpname_src", "work.cpname_dst");

  // The copy lands at the new path under the SAME name (a fresh id), so it is
  // addressable by (tree, name) there — not silently nulled out.
  const srcId = await db.resolveMemoryId(FULL, "work.cpname_src", "doc.md");
  const dstId = await db.resolveMemoryId(FULL, "work.cpname_dst", "doc.md");
  expect(srcId).not.toBeNull();
  expect(dstId).not.toBeNull();
  expect(dstId).not.toBe(srcId); // distinct row, same name
});

test("queueStats reports pending / in_flight / waiting / failed", async () => {
  // Isolate from other tests' enqueues: start from an empty queue.
  await sql.unsafe(`delete from ${schema}.embedding_queue`);

  expect(await db.queueStats()).toEqual({
    pending: 0,
    inFlight: 0,
    waiting: 0,
    failed: 0,
    oldestPendingAt: null,
  });

  // Each createMemory fires enqueue_embedding (embedding is null), seeding a
  // pending row that is claimable now (vt = now()).
  const a = await mustCreate(FULL, { tree: "work.qs.a", content: "a" });
  await mustCreate(FULL, { tree: "work.qs.b", content: "b" });
  await mustCreate(FULL, { tree: "work.qs.c", content: "c" });

  const seeded = await db.queueStats();
  expect(seeded.pending).toBe(3);
  expect(seeded.waiting).toBe(3);
  expect(seeded.inFlight).toBe(0);
  expect(seeded.failed).toBe(0);
  expect(seeded.oldestPendingAt).toBeInstanceOf(Date);

  // Simulate a worker claim on a's row: claim_embedding_batch pushes vt into the
  // future, so the row is still pending but counts as in_flight, not waiting.
  await sql.unsafe(
    `update ${schema}.embedding_queue set vt = now() + interval '5 minutes' where memory_id = $1`,
    [a],
  );
  const claimed = await db.queueStats();
  expect(claimed.pending).toBe(3);
  expect(claimed.inFlight).toBe(1);
  expect(claimed.waiting).toBe(2);

  // Terminal outcomes: 'failed' is counted; a 'completed' row leaves pending.
  await sql.unsafe(
    `update ${schema}.embedding_queue set outcome = 'failed' where memory_id = $1`,
    [a],
  );
  await sql.unsafe(
    `update ${schema}.embedding_queue set outcome = 'completed'
     where id = (select id from ${schema}.embedding_queue where outcome is null limit 1)`,
  );
  const final = await db.queueStats();
  expect(final.pending).toBe(1);
  expect(final.waiting).toBe(1);
  expect(final.inFlight).toBe(0);
  expect(final.failed).toBe(1);
});
