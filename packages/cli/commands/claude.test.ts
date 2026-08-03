/** Tests for Claude Code's dormant native assets. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initOutroLead } from "../agent/init.ts";

const pluginDir = join(import.meta.dir, "..", "..", "claude-plugin");

describe("Claude plugin assets", () => {
  test("registers exactly the dormant me mcp command", () => {
    const config = JSON.parse(
      readFileSync(join(pluginDir, ".mcp.json"), "utf8"),
    ) as { mcpServers: { me: { command: string; args: string[] } } };
    expect(config.mcpServers.me).toEqual({ command: "me", args: ["mcp"] });
  });

  test("has no install-time credential or routing configuration", () => {
    const plugin = JSON.parse(
      readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(plugin.userConfig).toBeUndefined();
  });

  test("installs only contract and dormant capture hooks", () => {
    const hooks = JSON.parse(
      readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(hooks.hooks)).toEqual([
      "SessionStart",
      "Stop",
      "SessionEnd",
    ]);
  });
});

describe("initOutroLead", () => {
  const backfill = { kind: "backfill" } as const;
  const ongoing = { kind: "ongoing" } as const;
  const config = { kind: "config" } as const;

  test("backfill + ongoing → imported history and hooks keep it updated", () => {
    const lead = initOutroLead([backfill, ongoing, config]).join(" ");
    expect(lead).toContain("Imported");
    expect(lead).toContain("going forward");
  });

  test("config only (or nothing) → no lead paragraph", () => {
    expect(initOutroLead([config])).toEqual([]);
    expect(initOutroLead([])).toEqual([]);
  });
});
