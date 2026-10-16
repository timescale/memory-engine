import { expect, test } from "bun:test";
import {
  type MemoryMutationCounts,
  recordMemoryMutation,
  withMutationTelemetry,
} from "./operation-telemetry";
import type { HandlerContext } from "./types";

const context: HandlerContext = { request: new Request("http://localhost") };

test("clones context, keeps sinks request-local, and derives allowlisted counts", () => {
  const first: Record<string, number | boolean>[] = [];
  const second: Record<string, number | boolean>[] = [];
  const a = withMutationTelemetry(context, (attrs) => first.push(attrs));
  const b = withMutationTelemetry(context, (attrs) => second.push(attrs));
  expect(a).not.toBe(context);
  expect(a.request).toBe(context.request);
  recordMemoryMutation(context, { inserted: 99 });
  recordMemoryMutation(a, {
    inserted: 2,
    updated: 3,
    skipped: 10,
    deleted: 4,
    copied: 5,
    moved: 6,
    reverted: 7,
    content: "secret",
    id: "secret",
    affected: 999,
  } as MemoryMutationCounts);
  recordMemoryMutation(b, {});
  expect(first).toEqual([
    {
      "memory.inserted_count": 2,
      "memory.updated_count": 3,
      "memory.skipped_count": 10,
      "memory.deleted_count": 4,
      "memory.copied_count": 5,
      "memory.moved_count": 6,
      "memory.reverted_count": 7,
      "memory.affected_count": 27,
      "memory.dry_run": false,
    },
  ]);
  expect(second[0]?.["memory.affected_count"]).toBe(0);
});

test("dry runs zero actual outcomes and retain candidate count", () => {
  let attributes: Record<string, number | boolean> = {};
  const ctx = withMutationTelemetry(context, (attrs) => {
    attributes = attrs;
  });
  recordMemoryMutation(ctx, {
    copied: 9,
    skipped: 2,
    dryRun: true,
    preview: 9,
  });
  expect(attributes["memory.preview_count"]).toBe(9);
  expect(attributes["memory.dry_run"]).toBe(true);
  for (const [key, value] of Object.entries(attributes)) {
    if (key !== "memory.preview_count" && key !== "memory.dry_run")
      expect(value).toBe(0);
  }
});

test("invalid numeric and boolean values and overflow are omitted, not coerced", () => {
  const calls: unknown[] = [];
  const ctx = withMutationTelemetry(context, (attrs) => calls.push(attrs));
  for (const value of [
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "3",
    null,
  ]) {
    recordMemoryMutation(ctx, { inserted: value } as MemoryMutationCounts);
    recordMemoryMutation(ctx, { preview: value } as MemoryMutationCounts);
  }
  recordMemoryMutation(ctx, {
    dryRun: "true",
  } as unknown as MemoryMutationCounts);
  recordMemoryMutation(ctx, {
    dryRun: null,
  } as unknown as MemoryMutationCounts);
  recordMemoryMutation(ctx, { inserted: Number.MAX_SAFE_INTEGER, updated: 1 });
  expect(calls).toEqual([]);
});

test("sink failures and hostile telemetry getters fail open", () => {
  const ctx = withMutationTelemetry(context, () => {
    throw new Error("offline");
  });
  expect(() => recordMemoryMutation(ctx, { inserted: 1 })).not.toThrow();
  expect(() =>
    recordMemoryMutation(ctx, {
      get inserted(): number {
        throw new Error("unavailable");
      },
    }),
  ).not.toThrow();
  const hostile = new Proxy(context, {
    ownKeys() {
      throw new Error("unavailable");
    },
  });
  expect(withMutationTelemetry(hostile, () => {})).toBe(hostile);
});

test("body-accessible string keys cannot install a sink", () => {
  let called = false;
  recordMemoryMutation(
    {
      ...context,
      mutationSink: () => {
        called = true;
      },
    },
    { deleted: 1 },
  );
  expect(called).toBe(false);
});
