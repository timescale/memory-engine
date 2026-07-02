/**
 * Tests for the managed post-commit hook block helpers.
 */
import { describe, expect, test } from "bun:test";
import {
  buildHookBlock,
  removeHookBlock,
  upsertHookScript,
} from "./import-git-hook.ts";

const BLOCK = buildHookBlock('"/usr/local/bin/me"');
const START = "# >>> memory-engine";

describe("buildHookBlock", () => {
  test("embeds the invocation, backgrounded and silenced", () => {
    expect(BLOCK).toContain(
      '("/usr/local/bin/me" import git >/dev/null 2>&1 &)',
    );
    expect(BLOCK.startsWith(START)).toBe(true);
    expect(BLOCK.endsWith("\n")).toBe(true);
  });

  test("supports a two-part source invocation", () => {
    const block = buildHookBlock('"/opt/bun" "/repo/packages/cli/index.ts"');
    expect(block).toContain(
      '("/opt/bun" "/repo/packages/cli/index.ts" import git >/dev/null 2>&1 &)',
    );
  });

  test("project scope bakes --as-agent before the subcommand", () => {
    const block = buildHookBlock('"/usr/local/bin/me"', { asAgent: ".me" });
    expect(block).toContain(
      '("/usr/local/bin/me" --as-agent .me import git >/dev/null 2>&1 &)',
    );
  });

  test("no as-agent by default (user/human variant)", () => {
    expect(BLOCK).not.toContain("--as-agent");
  });
});

describe("upsertHookScript", () => {
  test("creates a fresh script with a shebang", () => {
    const script = upsertHookScript(null, BLOCK);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script.split(START).length - 1).toBe(1);
  });

  test("treats an empty file as fresh", () => {
    expect(upsertHookScript("  \n", BLOCK).startsWith("#!/bin/sh\n")).toBe(
      true,
    );
  });

  test("appends once to a foreign hook, preserving it", () => {
    const foreign = '#!/bin/sh\necho "their hook"\n';
    const script = upsertHookScript(foreign, BLOCK);
    expect(script).toContain('echo "their hook"');
    expect(script.indexOf(START)).toBeGreaterThan(script.indexOf("their hook"));
    expect(script.split(START).length - 1).toBe(1);
  });

  test("re-install replaces the managed block in place without growth", () => {
    const v1 = upsertHookScript("#!/bin/sh\necho before\n", BLOCK);
    const newBlock = buildHookBlock('"/new/path/me"');
    const v2 = upsertHookScript(v1, newBlock);
    expect(v2.split(START).length - 1).toBe(1);
    expect(v2).toContain('"/new/path/me"');
    expect(v2).not.toContain("/usr/local/bin/me");
    expect(v2).toContain("echo before");
    // Idempotent: applying the same block again changes nothing.
    expect(upsertHookScript(v2, newBlock)).toBe(v2);
  });
});

describe("removeHookBlock", () => {
  test("returns null when only the shebang would remain", () => {
    const script = upsertHookScript(null, BLOCK);
    expect(removeHookBlock(script)).toBeNull();
  });

  test("preserves foreign content", () => {
    const foreign = '#!/bin/sh\necho "their hook"\n';
    const script = upsertHookScript(foreign, BLOCK);
    const remaining = removeHookBlock(script);
    expect(remaining).toContain('echo "their hook"');
    expect(remaining).not.toContain(START);
  });

  test("is a no-op on a script without the block", () => {
    const foreign = '#!/bin/sh\necho "their hook"\n';
    expect(removeHookBlock(foreign)).toBe(foreign);
  });
});
