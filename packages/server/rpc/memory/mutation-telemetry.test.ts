import { expect, test } from "bun:test";
import type { Memory, SpaceStore } from "@memory.build/engine/space";
import { withMutationTelemetry } from "../operation-telemetry";
import type { HandlerContext } from "../types";
import { memoryDataMethods } from "./memory";

type WriteResult = Awaited<ReturnType<SpaceStore["createMemory"]>>;

const id = "01900000-0000-7000-8000-000000000001";
const memory: Memory = {
  id,
  tree: "share.private",
  name: "secret.md",
  content: "private contents",
  meta: { credential: "private credential" },
  temporal: null,
  version: 3,
  versionHash: "a".repeat(32),
  hasEmbedding: false,
  createdAt: new Date(0),
  updatedAt: null,
};
const createParams = { content: memory.content, tree: "/share/private" };
const updateParams = {
  id,
  versionHash: memory.versionHash,
  content: memory.content,
};

type Attributes = Record<string, number | boolean>;
const zeros: Attributes = {
  "memory.inserted_count": 0,
  "memory.updated_count": 0,
  "memory.skipped_count": 0,
  "memory.deleted_count": 0,
  "memory.copied_count": 0,
  "memory.moved_count": 0,
  "memory.reverted_count": 0,
  "memory.affected_count": 0,
  "memory.dry_run": false,
};

function fixture(
  overrides: Partial<SpaceStore> = {},
  sink?: (attrs: Attributes) => void,
  rejectCommit = false,
) {
  const attributes: Attributes[] = [];
  const calls: string[] = [];
  let committed = false;
  // Typed overrides, with unexpected calls rejected: no DB, embeddings, or network.
  const methods: Partial<SpaceStore> = {
    getMemory: async () => memory,
    resolveMemoryId: async () => id,
    ...overrides,
  };
  const store = new Proxy(methods, {
    get(target, key) {
      if (key === "withEventContext") {
        return async (
          _event: unknown,
          fn: (store: SpaceStore) => Promise<unknown>,
        ) => {
          const result = await fn(store);
          if (rejectCommit) throw new Error("commit failed");
          committed = true;
          return result;
        };
      }
      const method = target[key as keyof SpaceStore];
      if (!method) throw new Error(`Unexpected store call: ${String(key)}`);
      return (...args: unknown[]) => {
        calls.push(String(key));
        return Reflect.apply(method, target, args);
      };
    },
  }) as SpaceStore;
  const context: HandlerContext = {
    request: new Request("http://localhost", {
      headers: { authorization: "Bearer private-token" },
    }),
    store,
    core: {},
    space: {},
    principalId: "private-principal-id",
    principalKind: "u",
    principalName: "private principal",
    apiKeyId: "private-key-id",
    apiKeyName: "private key",
    treeAccess: [],
  };
  const ctx = withMutationTelemetry(context, (attrs) => {
    expect(committed).toBe(true);
    attributes.push(attrs);
    sink?.(attrs);
  });
  return {
    attributes,
    calls,
    async call(name: string, params: unknown) {
      const method = memoryDataMethods.get(`memory.${name}`);
      if (!method) throw new Error(`Unknown method: ${name}`);
      return method.handler(method.schema.parse(params), ctx);
    },
  };
}

for (const status of ["inserted", "updated", "skipped"] as const) {
  test(`create uses actual ${status} status without changing the memory wire response`, async () => {
    const f = fixture({ createMemory: async () => ({ id, status }) });
    const result = await f.call("create", {
      ...createParams,
      onConflict: "ignore",
    });
    expect(result).toMatchObject({ id, content: memory.content, version: 3 });
    expect(result).not.toHaveProperty("status");
    expect(f.attributes).toEqual([
      {
        ...zeros,
        [`memory.${status}_count`]: 1,
        "memory.affected_count": status === "skipped" ? 0 : 1,
      },
    ]);
    expect(f.calls).toEqual(["createMemory", "getMemory"]);
  });
}

test("batch summarizes each returned row (not inputs or unique ids) and preserves wire", async () => {
  const results: WriteResult[] = [
    { id, status: "inserted" },
    { id, status: "updated" },
    { id, status: "skipped" },
    { id, status: "skipped" },
  ];
  const f = fixture({ batchCreateMemories: async () => results });
  expect(await f.call("batchCreate", { memories: [createParams] })).toEqual({
    results,
  });
  expect(f.attributes).toEqual([
    {
      ...zeros,
      "memory.inserted_count": 1,
      "memory.updated_count": 1,
      "memory.skipped_count": 2,
      "memory.affected_count": 2,
    },
  ]);
  expect(f.calls).toEqual(["batchCreateMemories"]);
});

test("all-skipped batch emits canonical zeros for writes", async () => {
  const f = fixture({
    batchCreateMemories: async () => [{ id, status: "skipped" }],
  });
  await f.call("batchCreate", {
    memories: [createParams],
    onConflict: "replace",
  });
  expect(f.attributes).toEqual([{ ...zeros, "memory.skipped_count": 1 }]);
});

test("identical update still counts one SQL UPDATE outcome, not a logical version change", async () => {
  const f = fixture({ patchMemory: async () => true });
  expect(await f.call("update", updateParams)).toMatchObject({
    version: memory.version,
  });
  expect(f.attributes).toEqual([
    { ...zeros, "memory.updated_count": 1, "memory.affected_count": 1 },
  ]);
});

test("revert counts only reverted, without guessing update vs undelete or logical change", async () => {
  const f = fixture({ revertMemory: async () => true });
  await f.call("revert", { id, version: 3 });
  expect(f.attributes).toEqual([
    { ...zeros, "memory.reverted_count": 1, "memory.affected_count": 1 },
  ]);
});

for (const name of ["delete", "deleteByPath"]) {
  test(`${name} counts one successful deletion`, async () => {
    const f = fixture({ deleteMemory: async () => true });
    expect(
      await f.call(name, { id, path: "/share/private/secret.md" }),
    ).toEqual({ deleted: true });
    expect(f.attributes).toEqual([
      { ...zeros, "memory.deleted_count": 1, "memory.affected_count": 1 },
    ]);
  });
}

const bulk = [
  {
    name: "copy",
    key: "copied",
    method: "copyTree",
    params: { source: "/share/private", destination: "/share/copy" },
  },
  {
    name: "move",
    key: "moved",
    method: "moveTree",
    params: { source: "/share/private", destination: "/share/move" },
  },
  {
    name: "deleteTree",
    key: "deleted",
    method: "deleteTree",
    params: { tree: "/share/private" },
  },
  {
    name: "deleteOrphansInTree",
    key: "deleted",
    method: "deleteOrphansInTree",
    params: {
      root: "/share/private",
      metaContains: { source: "private" },
      keep: [],
    },
  },
] as const;

for (const operation of bulk) {
  for (const count of [0, 2]) {
    for (const dryRun of [undefined, false, true]) {
      test(`${operation.name}: returned ${count}, dryRun=${dryRun}`, async () => {
        const result =
          operation.method === "deleteOrphansInTree"
            ? Array.from({ length: count }, () => ({
                id,
                tree: memory.tree,
                name: "secret.md",
              }))
            : count;
        const f = fixture({
          [operation.method]: async (...args: unknown[]) => {
            expect(args.at(-1)).toBe(dryRun ?? false);
            return result;
          },
        });
        expect(
          await f.call(operation.name, { ...operation.params, dryRun }),
        ).toMatchObject({ count });
        expect(f.attributes).toEqual([
          dryRun
            ? {
                ...zeros,
                "memory.dry_run": true,
                "memory.preview_count": count,
              }
            : {
                ...zeros,
                [`memory.${operation.key}_count`]: count,
                "memory.affected_count": count,
              },
        ]);
        expect(f.calls).toEqual([operation.method]);
      });
    }
  }
}

for (const [name, method, params] of [
  ["create", "createMemory", createParams],
  ["batchCreate", "batchCreateMemories", { memories: [createParams] }],
  ["update", "patchMemory", updateParams],
  ["revert", "revertMemory", { id, version: 1 }],
  ["delete", "deleteMemory", { id }],
  ["deleteByPath", "deleteMemory", { path: "/share/private/secret.md" }],
  ...bulk.map((op) => [op.name, op.method, op.params] as const),
] as const) {
  test(`${name} emits nothing when mutation transaction rejects`, async () => {
    const f = fixture({
      [method]: async () => {
        throw new Error("write failed");
      },
    });
    await expect(f.call(name, params)).rejects.toThrow("write failed");
    expect(f.attributes).toEqual([]);
  });
}

for (const [name, method, params] of [
  ["update", "patchMemory", updateParams],
  ["revert", "revertMemory", { id, version: 1 }],
  ["delete", "deleteMemory", { id }],
  ["deleteByPath", "deleteMemory", { path: "/share/private/secret.md" }],
] as const) {
  test(`${name} false/not-found result emits nothing`, async () => {
    const f = fixture({ [method]: async () => false });
    await expect(f.call(name, params)).rejects.toThrow();
    expect(f.attributes).toEqual([]);
  });
}

for (const [name, method, params, key, result] of [
  [
    "create",
    "createMemory",
    createParams,
    "inserted",
    { id, status: "inserted" },
  ],
  ["update", "patchMemory", updateParams, "updated", true],
  ["revert", "revertMemory", { id, version: 1 }, "reverted", true],
] as const) {
  test(`${name} records known write before a failed follow-up read`, async () => {
    const f = fixture({
      [method]: async () => result,
      getMemory: async () => {
        expect(f.attributes).toEqual([
          { ...zeros, [`memory.${key}_count`]: 1, "memory.affected_count": 1 },
        ]);
        throw new Error("read failed");
      },
    });
    await expect(f.call(name, params)).rejects.toThrow("read failed");
  });
}

test("sink failures do not change success; attributes contain no data, credentials, or ids", async () => {
  const f = fixture(
    { createMemory: async () => ({ id, status: "inserted" }) },
    () => {
      throw new Error("sink failed");
    },
  );
  expect(
    await f.call("create", { ...createParams, meta: memory.meta }),
  ).toMatchObject({ id });
  expect(f.attributes).toEqual([
    { ...zeros, "memory.inserted_count": 1, "memory.affected_count": 1 },
  ]);
  const serialized = JSON.stringify(f.attributes);
  for (const secret of [
    id,
    memory.content,
    "credential",
    "private-token",
    "private-key-id",
    "private-principal-id",
  ]) {
    expect(serialized).not.toContain(secret);
  }
});

test("a store outcome is not emitted before its enclosing transaction resolves", async () => {
  const f = fixture(
    { createMemory: async () => ({ id, status: "inserted" }) },
    undefined,
    true,
  );
  await expect(f.call("create", createParams)).rejects.toThrow("commit failed");
  expect(f.attributes).toEqual([]);
  expect(f.calls).toEqual(["createMemory"]);
});

test("unresolved delete path never emits mutation counts", async () => {
  const f = fixture({ resolveMemoryId: async () => null });
  await expect(
    f.call("deleteByPath", { path: "/share/private/missing.md" }),
  ).rejects.toThrow();
  expect(f.attributes).toEqual([]);
  expect(f.calls).toEqual(["resolveMemoryId"]);
});

test("unknown store status is not guessed from input", async () => {
  const f = fixture({
    createMemory: async () =>
      ({ id, status: "unknown" }) as unknown as WriteResult,
  });
  await f.call("create", createParams);
  expect(f.attributes).toEqual([]);
});
