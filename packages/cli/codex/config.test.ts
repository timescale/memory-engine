/**
 * Tests for Codex config shaping (`codex/config.ts`): the managed TOML block
 * and the hooks.json merge.
 */
import { describe, expect, test } from "bun:test";
import {
  codexHookCommand,
  codexHooksHasCapture,
  codexTomlMarkers,
  removeCodexHooks,
  renderCodexTomlBlock,
  upsertCodexHooks,
} from "./config.ts";

describe("renderCodexTomlBlock", () => {
  test("user scope: mcp server only, no agent mode, no shell env", () => {
    const block = renderCodexTomlBlock("user", ["me", "mcp"]);
    expect(block).toContain(codexTomlMarkers("user").start);
    expect(block).toContain("[mcp_servers.me]");
    expect(block).toContain('command = "me"');
    expect(block).toContain('args = ["mcp"]');
    expect(block).not.toContain("--as-agent");
    expect(block).not.toContain("shell_environment_policy");
  });

  test("project scope: agent-mode args + shell_environment_policy", () => {
    const block = renderCodexTomlBlock("project", [
      "me",
      "--as-agent",
      ".me",
      "mcp",
    ]);
    expect(block).toContain('args = ["--as-agent", ".me", "mcp"]');
    expect(block).toContain("[shell_environment_policy]");
    expect(block).toContain('set = { ME_AS_AGENT = ".me" }');
  });

  test("block is marker-delimited (removable)", () => {
    const m = codexTomlMarkers("project");
    const block = renderCodexTomlBlock("project", ["me", "mcp"]);
    expect(block.startsWith(m.start)).toBe(true);
    expect(block.trimEnd().endsWith(m.end)).toBe(true);
  });
});

describe("codexHookCommand", () => {
  test("user vs project", () => {
    expect(codexHookCommand("user")).toBe(
      "me codex hook --scope user --event stop",
    );
    expect(codexHookCommand("project")).toBe(
      "me --as-agent .me codex hook --scope project --event stop",
    );
  });
});

describe("codex hooks.json merge", () => {
  test("upsert adds a Stop capture hook (timeout in seconds)", () => {
    const f = upsertCodexHooks({}, { scope: "project" });
    expect(codexHooksHasCapture(f)).toBe(true);
    const stop = (f.hooks as Record<string, { hooks: { timeout: number }[] }[]>)
      .Stop;
    expect(stop).toHaveLength(1);
    expect(stop?.[0]?.hooks[0]?.timeout).toBe(60);
  });

  test("preserves foreign hooks; idempotent", () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "other run" }] }],
        SessionStart: [{ hooks: [{ command: "hi" }] }],
      },
    };
    const once = upsertCodexHooks(existing, { scope: "user" });
    const twice = upsertCodexHooks(once, { scope: "user" });
    expect(twice).toEqual(once);
    const hooks = twice.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(2); // foreign + ours
    expect(hooks.SessionStart).toHaveLength(1);
  });

  test("remove strips ours, keeps foreign, drops empties", () => {
    const installed = upsertCodexHooks(
      { hooks: { Stop: [{ hooks: [{ command: "other" }] }] } },
      { scope: "user" },
    );
    const removed = removeCodexHooks(installed);
    expect(codexHooksHasCapture(removed)).toBe(false);
    expect((removed.hooks as Record<string, unknown[]>).Stop).toHaveLength(1);

    const onlyOurs = upsertCodexHooks({}, { scope: "user" });
    expect(removeCodexHooks(onlyOurs).hooks).toBeUndefined();
  });
});
