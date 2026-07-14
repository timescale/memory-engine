/**
 * Tests for project identity normalization, git context detection, and
 * collision resolution.
 *
 * Note: the registry calls out to git for root/remote detection. These tests
 * pass cwds that aren't real git repos, so the lookup silently returns
 * `undefined` and the fallback to `basename(cwd)` is exercised.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedUniqueLabel,
  detectGitContext,
  normalizeProjectSlug,
  ProjectRegistry,
  repoNameFromRemote,
} from "./project.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}${stdout}`);
  }
}

describe("repoNameFromRemote", () => {
  test("extracts the repo name from https and ssh remotes (sans .git)", () => {
    expect(repoNameFromRemote("https://github.com/org/memory-engine.git")).toBe(
      "memory-engine",
    );
    expect(repoNameFromRemote("git@github.com:org/memory-engine.git")).toBe(
      "memory-engine",
    );
    expect(repoNameFromRemote("https://example.com/a/b/repo")).toBe("repo");
  });
});

describe("normalizeProjectSlug", () => {
  test("lowercases and replaces non-alphanumeric with underscore", () => {
    expect(normalizeProjectSlug("Memory-Engine")).toBe("memory_engine");
    expect(normalizeProjectSlug("My Project!")).toBe("my_project");
  });

  test("collapses underscores and trims edges", () => {
    expect(normalizeProjectSlug("---foo---bar---")).toBe("foo_bar");
    expect(normalizeProjectSlug("foo__bar")).toBe("foo_bar");
  });

  test("prefixes purely numeric labels", () => {
    expect(normalizeProjectSlug("12345")).toBe("p_12345");
  });

  test("returns 'unknown' for empty or all-symbol input", () => {
    expect(normalizeProjectSlug("")).toBe("unknown");
    expect(normalizeProjectSlug("!!!")).toBe("unknown");
  });
});

describe("detectGitContext", () => {
  test("returns gitRoot and gitRemote inside a repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "me-project-registry-"));
    try {
      await git(root, ["init", "-q", "-b", "main"]);
      await git(root, [
        "remote",
        "add",
        "origin",
        "git@github.com:acme/widgets.git",
      ]);
      const context = await detectGitContext(root);
      expect(context.gitRoot).toBe(await realpath(root));
      expect(context.gitRemote).toBe("git@github.com:acme/widgets.git");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns an empty context outside a repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "me-project-registry-"));
    try {
      expect(await detectGitContext(root)).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns gitRoot without gitRemote for a repo with no origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "me-project-registry-"));
    try {
      await git(root, ["init", "-q", "-b", "main"]);
      const context = await detectGitContext(root);
      expect(context.gitRoot).toBe(await realpath(root));
      expect(context.gitRemote).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("boundedUniqueLabel", () => {
  // The name-charset normalizer used by messageName (dashes/dots/underscores ok).
  const nameNorm = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

  test("returns a clean, fitting id unchanged (no hash suffix)", () => {
    expect(boundedUniqueLabel("343a75a0-8037-4579", nameNorm, 124)).toBe(
      "343a75a0-8037-4579",
    );
    expect(boundedUniqueLabel("a_b", nameNorm, 124)).toBe("a_b");
  });

  test("keeps distinct ids distinct when normalization would collapse them", () => {
    // a/b, a:b, a_b all normalize to "a_b" — the hash of the original keeps
    // them in three different slots.
    const a = boundedUniqueLabel("a/b", nameNorm, 124);
    const b = boundedUniqueLabel("a:b", nameNorm, 124);
    const c = boundedUniqueLabel("a_b", nameNorm, 124);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(c).toBe("a_b"); // already clean → unchanged
    expect(a.startsWith("a_b_")).toBe(true); // lossy → disambiguated
  });

  test("caps length and stays unique when truncating", () => {
    const a = boundedUniqueLabel("x".repeat(300), nameNorm, 124);
    const b = boundedUniqueLabel(`${"x".repeat(299)}y`, nameNorm, 124);
    expect(a.length).toBeLessThanOrEqual(124);
    expect(b.length).toBeLessThanOrEqual(124);
    expect(a).not.toBe(b); // share the truncated prefix but differ by hash
  });

  test("is deterministic (stable as an idempotency key)", () => {
    expect(boundedUniqueLabel("a/b", nameNorm, 124)).toBe(
      boundedUniqueLabel("a/b", nameNorm, 124),
    );
  });

  test("disambiguates a lossy ltree label via normalizeProjectSlug", () => {
    const dashed = boundedUniqueLabel("sess-1", normalizeProjectSlug, 200);
    const under = boundedUniqueLabel("sess_1", normalizeProjectSlug, 200);
    expect(under).toBe("sess_1"); // already a clean ltree label
    expect(dashed).not.toBe(under); // "sess-1" → sess_1, disambiguated
    expect(dashed.startsWith("sess_1_")).toBe(true);
  });
});

describe("ProjectRegistry", () => {
  test("returns unknown for undefined cwd", async () => {
    const reg = new ProjectRegistry();
    const result = await reg.resolve(undefined);
    expect(result.slug).toBe("unknown");
    expect(result.baseSlug).toBe("unknown");
  });

  test("same cwd resolves to the same slug on repeated calls", async () => {
    const reg = new ProjectRegistry();
    const a = await reg.resolve("/tmp/nonexistent-path-for-test/memory-engine");
    const b = await reg.resolve("/tmp/nonexistent-path-for-test/memory-engine");
    expect(a.slug).toBe(b.slug);
  });

  test("distinct cwds with the same basename get disambiguating suffix", async () => {
    const reg = new ProjectRegistry();
    const a = await reg.resolve("/tmp/nonexistent-a-1234abcd/memory-engine");
    const b = await reg.resolve("/tmp/nonexistent-b-5678efgh/memory-engine");
    expect(a.baseSlug).toBe("memory_engine");
    expect(b.baseSlug).toBe("memory_engine");
    expect(a.slug).toBe("memory_engine");
    expect(b.slug).toMatch(/^memory_engine_[0-9a-f]{4}$/);
    expect(a.slug).not.toBe(b.slug);
  });

  test("collisions() reports all colliding base slugs", async () => {
    const reg = new ProjectRegistry();
    await reg.resolve("/tmp/nonexistent-a-1234abcd/memory-engine");
    await reg.resolve("/tmp/nonexistent-b-5678efgh/memory-engine");
    await reg.resolve("/tmp/nonexistent-c-abcdefgh/other-project");
    const collisions = reg.collisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.baseSlug).toBe("memory_engine");
    expect(collisions[0]?.cwds).toHaveLength(2);
  });
});
