/**
 * Tests for slug normalization and collision resolution.
 *
 * Note: the registry calls out to git for root/remote detection. These tests
 * pass cwds that aren't real git repos, so the lookup silently returns
 * `undefined` and the fallback to `basename(cwd)` is exercised.
 */
import { describe, expect, test } from "bun:test";
import { normalizeSlug, SlugRegistry } from "./slug.ts";

describe("normalizeSlug", () => {
  test("lowercases and replaces non-alphanumeric with underscore", () => {
    expect(normalizeSlug("Memory-Engine")).toBe("memory_engine");
    expect(normalizeSlug("My Project!")).toBe("my_project");
  });

  test("collapses underscores and trims edges", () => {
    expect(normalizeSlug("---foo---bar---")).toBe("foo_bar");
    expect(normalizeSlug("foo__bar")).toBe("foo_bar");
  });

  test("prefixes purely numeric labels", () => {
    expect(normalizeSlug("12345")).toBe("p_12345");
  });

  test("returns 'unknown' for empty or all-symbol input", () => {
    expect(normalizeSlug("")).toBe("unknown");
    expect(normalizeSlug("!!!")).toBe("unknown");
  });
});

describe("SlugRegistry", () => {
  test("returns unknown for undefined cwd", async () => {
    const reg = new SlugRegistry();
    const result = await reg.resolve(undefined);
    expect(result.slug).toBe("unknown");
    expect(result.baseSlug).toBe("unknown");
  });

  test("same cwd resolves to the same slug on repeated calls", async () => {
    const reg = new SlugRegistry();
    const a = await reg.resolve("/tmp/nonexistent-path-for-test/memory-engine");
    const b = await reg.resolve("/tmp/nonexistent-path-for-test/memory-engine");
    expect(a.slug).toBe(b.slug);
  });

  test("distinct cwds with the same basename get disambiguating suffix", async () => {
    const reg = new SlugRegistry();
    const a = await reg.resolve("/tmp/nonexistent-a-1234abcd/memory-engine");
    const b = await reg.resolve("/tmp/nonexistent-b-5678efgh/memory-engine");
    expect(a.baseSlug).toBe("memory_engine");
    expect(b.baseSlug).toBe("memory_engine");
    expect(a.slug).toBe("memory_engine");
    expect(b.slug).toMatch(/^memory_engine_[0-9a-f]{4}$/);
    expect(a.slug).not.toBe(b.slug);
  });

  test("collisions() reports all colliding base slugs", async () => {
    const reg = new SlugRegistry();
    await reg.resolve("/tmp/nonexistent-a-1234abcd/memory-engine");
    await reg.resolve("/tmp/nonexistent-b-5678efgh/memory-engine");
    await reg.resolve("/tmp/nonexistent-c-abcdefgh/other-project");
    const collisions = reg.collisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.baseSlug).toBe("memory_engine");
    expect(collisions[0]?.cwds).toHaveLength(2);
  });
});
