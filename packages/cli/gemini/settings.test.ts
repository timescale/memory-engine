/**
 * Tests for Gemini settings.json shaping (`gemini/settings.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  geminiHookCommand,
  geminiHooksHasCapture,
  removeGeminiHooks,
  removeGeminiMcp,
  upsertGeminiHooks,
  upsertGeminiMcp,
} from "./settings.ts";

describe("geminiHookCommand", () => {
  test("user vs project + event flags", () => {
    expect(geminiHookCommand("user", "AfterAgent")).toBe(
      "me gemini hook --scope user --event after-agent",
    );
    expect(geminiHookCommand("project", "SessionEnd")).toBe(
      "me --as-agent .me gemini hook --scope project --event session-end",
    );
  });
});

describe("gemini hooks", () => {
  test("upsert adds AfterAgent + SessionEnd (timeout in ms)", () => {
    const s = upsertGeminiHooks({}, { scope: "project" });
    expect(geminiHooksHasCapture(s)).toBe(true);
    const hooks = s.hooks as Record<string, { hooks: { timeout: number }[] }[]>;
    expect(hooks.AfterAgent).toHaveLength(1);
    expect(hooks.SessionEnd).toHaveLength(1);
    expect(hooks.AfterAgent?.[0]?.hooks[0]?.timeout).toBe(60000);
  });

  test("preserves foreign hooks; idempotent", () => {
    const existing = {
      hooks: { AfterAgent: [{ hooks: [{ command: "other run" }] }] },
    };
    const once = upsertGeminiHooks(existing, { scope: "user" });
    const twice = upsertGeminiHooks(once, { scope: "user" });
    expect(twice).toEqual(once);
    expect((twice.hooks as Record<string, unknown[]>).AfterAgent).toHaveLength(
      2,
    );
  });

  test("remove strips ours; drops empties", () => {
    const s = upsertGeminiHooks({}, { scope: "user" });
    const removed = removeGeminiHooks(s);
    expect(geminiHooksHasCapture(removed)).toBe(false);
    expect(removed.hooks).toBeUndefined();
  });
});

describe("gemini mcpServers.me", () => {
  test("upsert writes command + args from a meCmd array", () => {
    const s = upsertGeminiMcp({}, ["me", "--as-agent", ".me", "mcp"]);
    expect(s.mcpServers).toEqual({
      me: { command: "me", args: ["--as-agent", ".me", "mcp"] },
    });
  });

  test("preserves sibling servers; remove drops only ours", () => {
    const s = upsertGeminiMcp({ mcpServers: { other: { command: "x" } } }, [
      "me",
      "mcp",
    ]);
    const servers = s.mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ command: "x" });
    const removed = removeGeminiMcp(s);
    expect((removed.mcpServers as Record<string, unknown>).me).toBeUndefined();
    expect((removed.mcpServers as Record<string, unknown>).other).toBeDefined();
  });

  test("remove drops an emptied mcpServers", () => {
    const s = upsertGeminiMcp({}, ["me", "mcp"]);
    expect(removeGeminiMcp(s).mcpServers).toBeUndefined();
  });
});
