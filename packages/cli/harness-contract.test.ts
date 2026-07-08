/**
 * Tests for the harness-injected environment contract: var construction, the
 * shell-quoted block renderer, and the idempotent env-file upsert.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContractVars,
  isInjectionLive,
  ME_INJECT_VERSION,
  renderContractBlock,
  upsertContractBlock,
} from "./harness-contract.ts";

test("buildContractVars sets all four vars", () => {
  const vars = buildContractVars("claude", "/repo/project");
  expect(vars.ME_INJECT_V).toBe(ME_INJECT_VERSION);
  expect(vars.AI_AGENT).toBe("claude");
  expect(vars.ME_AS_AGENT).toBe(".me");
  expect(vars.ME_PROJECT_DIR).toBe("/repo/project");
});

test("isInjectionLive reflects ME_INJECT_V presence", () => {
  expect(isInjectionLive({})).toBe(false);
  expect(isInjectionLive({ ME_INJECT_V: "1" })).toBe(true);
});

test("renderContractBlock escapes shell-special characters", () => {
  const block = renderContractBlock({
    ME_PROJECT_DIR: `/tmp/it's a "test" dir \\$HOME \`whoami\``,
  });
  expect(block).toContain(
    'export ME_PROJECT_DIR="/tmp/it\'s a \\"test\\" dir \\\\\\$HOME \\`whoami\\`"',
  );
});

test("upsertContractBlock creates the file when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "me-contract-"));
  try {
    const path = join(dir, "nested", "env.sh");
    upsertContractBlock(path, { AI_AGENT: "claude" });
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('export AI_AGENT="claude"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertContractBlock replaces a previous block in place, preserving surrounding content", () => {
  const dir = mkdtempSync(join(tmpdir(), "me-contract-"));
  try {
    const path = join(dir, "env.sh");
    writeFileSync(path, "export SOME_OTHER_VAR=1\n");
    upsertContractBlock(path, { AI_AGENT: "claude", ME_PROJECT_DIR: "/a" });
    upsertContractBlock(path, { AI_AGENT: "claude", ME_PROJECT_DIR: "/b" });

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("export SOME_OTHER_VAR=1");
    expect(content).toContain('export ME_PROJECT_DIR="/b"');
    expect(content).not.toContain('export ME_PROJECT_DIR="/a"');
    // Exactly one block survives.
    expect(content.match(/memory-engine \(harness contract\)/g)?.length).toBe(
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertContractBlock appends after existing content without a block yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "me-contract-"));
  try {
    const path = join(dir, "env.sh");
    writeFileSync(path, "export SOME_OTHER_VAR=1");
    upsertContractBlock(path, { AI_AGENT: "opencode" });
    const content = readFileSync(path, "utf-8");
    expect(content.startsWith("export SOME_OTHER_VAR=1\n")).toBe(true);
    expect(content).toContain('export AI_AGENT="opencode"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
