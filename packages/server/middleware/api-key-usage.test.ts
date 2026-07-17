import { beforeEach, describe, expect, test } from "bun:test";
import type { CoreStore } from "@memory.build/engine/core";
import {
  apiKeyUsageCacheSizeForTest,
  recordApiKeyUse,
  resetApiKeyUsageCacheForTest,
} from "./api-key-usage";

function fakeCore(touches: string[]): CoreStore {
  return {
    async touchApiKey(id: string, usedOn: string) {
      touches.push(`${id}:${usedOn}`);
      return true;
    },
  } as unknown as CoreStore;
}

describe("recordApiKeyUse", () => {
  beforeEach(() => {
    resetApiKeyUsageCacheForTest(new Date("2026-07-17T00:00:00Z"));
  });

  test("touches once per key per UTC day", async () => {
    const touches: string[] = [];
    const core = fakeCore(touches);

    await recordApiKeyUse(core, "key-1", new Date("2026-07-17T01:00:00Z"));
    await recordApiKeyUse(core, "key-1", new Date("2026-07-17T23:00:00Z"));
    await recordApiKeyUse(core, "key-1", new Date("2026-07-18T01:00:00Z"));

    expect(touches).toEqual(["key-1:2026-07-17", "key-1:2026-07-18"]);
  });

  test("swallows failed touches and does not retry the same key/day", async () => {
    const touches: string[] = [];
    const core = {
      async touchApiKey(id: string, usedOn: string) {
        touches.push(`${id}:${usedOn}`);
        throw new Error("temporary failure");
      },
    } as unknown as CoreStore;

    await recordApiKeyUse(core, "key-1", new Date("2026-07-17T01:00:00Z"));
    await recordApiKeyUse(core, "key-1", new Date("2026-07-17T02:00:00Z"));

    expect(touches).toEqual(["key-1:2026-07-17"]);
  });

  test("lazy flush clears the cache after 24 hours", async () => {
    const touches: string[] = [];
    const core = fakeCore(touches);

    // Two same-day touches populate the cache; direct inspection of the
    // module-global size is the only way to observe the flush itself, since
    // any date-changing test would trip a cache miss on the date alone.
    await recordApiKeyUse(core, "key-1", new Date("2026-07-17T00:00:00Z"));
    await recordApiKeyUse(core, "key-2", new Date("2026-07-17T12:00:00Z"));
    expect(apiKeyUsageCacheSizeForTest()).toBe(2);

    // 24h + 1min after reset → the flush condition fires at the start of the
    // call; the cache is then re-seeded with just the current call's key.
    await recordApiKeyUse(core, "key-3", new Date("2026-07-18T00:01:00Z"));
    expect(apiKeyUsageCacheSizeForTest()).toBe(1);
    expect(touches).toEqual([
      "key-1:2026-07-17",
      "key-2:2026-07-17",
      "key-3:2026-07-18",
    ]);
  });

  test("lazy flush clears entries after the maximum cache size", async () => {
    const touches: string[] = [];
    const core = fakeCore(touches);
    const now = new Date("2026-07-17T01:00:00Z");

    for (let i = 0; i <= 10_000; i += 1) {
      await recordApiKeyUse(core, `key-${i}`, now);
    }
    // Cache is now bounded at 10_001 entries — the +1 is the deliberate soft
    // overshoot documented in api-key-usage.ts (the size check runs before
    // the current insert). The next call trips the check and clears.
    expect(apiKeyUsageCacheSizeForTest()).toBe(10_001);

    await recordApiKeyUse(core, "key-0", now);

    // After the flush the cache holds only the current call's entry.
    expect(apiKeyUsageCacheSizeForTest()).toBe(1);
    expect(touches).toHaveLength(10_002);
    expect(touches.at(-1)).toBe("key-0:2026-07-17");
  });
});
