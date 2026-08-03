import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getHarness,
  HARNESS_NAMES,
  parseHarnessName,
  resolveHarnessTargets,
} from "./registry.ts";

describe("harness registry", () => {
  test("has the frozen canonical names and metadata", () => {
    expect(HARNESS_NAMES).toEqual(["claude", "opencode", "codex", "gemini"]);
    expect(getHarness("claude").displayName).toBe("Claude Code");
    expect(getHarness("opencode").binary).toBe("opencode");
  });

  test("parses only canonical names", () => {
    expect(parseHarnessName("codex")).toBe("codex");
    expect(() => parseHarnessName("Claude")).toThrow("unknown harness");
  });

  test("keeps explicit aggregate selections in argument order", () => {
    expect(resolveHarnessTargets(["gemini", "claude"], true)).toEqual([
      "gemini",
      "claude",
    ]);
  });

  test("uses PATH detection for argument-free install and inventory for uninstall", () => {
    const detected = () => [getHarness("claude"), getHarness("gemini")];
    expect(resolveHarnessTargets([], true, detected)).toEqual([
      "claude",
      "gemini",
    ]);
    expect(
      resolveHarnessTargets([], false, detected, (name) => name === "codex"),
    ).toEqual(["codex"]);
  });

  test("retains a modified OpenCode MCP entry on uninstall", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "me-registry-")),
      "opencode.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        mcp: {
          me: { type: "local", command: ["me", "mcp"], extra: true },
          other: { command: ["other"] },
        },
      }),
    );
    const result = await getHarness("opencode").uninstall({
      installed_at: "2026-08-03T14:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [{ kind: "mcp-json", path, server_name: "me" }],
    });
    expect(result.retained).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).mcp.me.extra).toBe(true);
  });
});
