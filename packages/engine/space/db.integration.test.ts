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
  if (created === null) throw new Error("unexpected duplicate-id skip");
  if (!created.inserted) throw new Error("unexpected replace");
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
});

test("createMemory returns null for a duplicate explicit id", async () => {
  const id = "01900000-0000-7000-8000-0000000000d0";
  const first = await db.createMemory(FULL, {
    id,
    tree: "work.dup",
    content: "original",
  });
  expect(first).toEqual({ id, inserted: true });

  // Re-submitting the same id is a no-op skip, not an error.
  const second = await db.createMemory(FULL, {
    id,
    tree: "work.dup",
    content: "replacement",
  });
  expect(second).toBeNull();
  expect((await db.getMemory(FULL, id))?.content).toBe("original");
});

test("createMemory with replaceIfMetaDiffers rewrites stale rows in place", async () => {
  const id = "01900000-0000-7000-8000-0000000000d1";
  await db.createMemory(FULL, {
    id,
    tree: "work.upsert",
    content: "render v1",
    meta: { importer_version: "1" },
  });

  // Same version → skip.
  const same = await db.createMemory(FULL, {
    id,
    tree: "work.upsert",
    content: "render v1 again",
    meta: { importer_version: "1" },
    replaceIfMetaDiffers: "importer_version",
  });
  expect(same).toBeNull();
  expect((await db.getMemory(FULL, id))?.content).toBe("render v1");

  // Bumped version → replaced, reported as an update (inserted: false).
  const bumped = await db.createMemory(FULL, {
    id,
    tree: "work.upsert",
    content: "render v2",
    meta: { importer_version: "2" },
    replaceIfMetaDiffers: "importer_version",
  });
  expect(bumped).toEqual({ id, inserted: false });
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
      { id: stale, tree: "work.batch", content: "new", meta: { v: "2" } },
      { id: fresh, tree: "work.batch", content: "untouched", meta: { v: "2" } },
      { tree: "work.batch", content: "generated id" },
    ],
    "v",
  );
  const byId = new Map(rows.map((r) => [r.id, r.inserted]));
  expect(rows).toHaveLength(2); // fresh skipped → absent
  expect(byId.get(stale)).toBe(false);
  expect((await db.getMemory(FULL, stale))?.content).toBe("new");
  expect((await db.getMemory(FULL, fresh))?.content).toBe("current");
  const generated = rows.find((r) => r.id !== stale);
  expect(generated?.inserted).toBe(true);
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
  expect(await db.patchMemory(FULL, id, { content: "after" })).toBe(true);
  expect((await db.getMemory(FULL, id))?.content).toBe("after");

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

test("vector search ranks by embedding similarity", async () => {
  const near = await mustCreate(FULL, {
    tree: "work.v1",
    content: "near",
  });
  const far = await mustCreate(FULL, { tree: "work.v2", content: "far" });
  await setEmbedding(near, [1, 0, 0, 0]);
  await setEmbedding(far, [0, 1, 0, 0]);

  const results = await db.search(FULL, { vec: [1, 0, 0, 0], limit: 5 });
  expect(results[0]?.id).toBe(near);
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
