import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getHarness,
  HARNESS_NAMES,
  installHarness,
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

  test("rolls back a newly installed registration when inventory persistence fails", async () => {
    const artifact = {
      kind: "mcp-cli" as const,
      server_name: "me" as const,
      scope: "user" as const,
    };
    let rollbackRecord: unknown;
    await expect(
      installHarness("claude", {
        harness: {
          ...getHarness("claude"),
          install: async () => ({ artifacts: [artifact], messages: [] }),
          uninstall: async (record) => {
            rollbackRecord = record;
            return { removed: [artifact], retained: [], messages: [] };
          },
        },
        writeInstallation: () => {
          throw new Error("disk is read-only");
        },
      }),
    ).rejects.toThrow(/registration was rolled back/);
    expect(rollbackRecord).toMatchObject({ artifacts: [artifact] });
  });

  test("does not roll back a preserved registration when inventory persistence fails", async () => {
    const artifact = {
      kind: "mcp-cli" as const,
      server_name: "me" as const,
      scope: "user" as const,
    };
    const existing = {
      installed_at: "2026-08-03T14:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [artifact],
    };
    let uninstalled = false;

    await expect(
      installHarness("claude", {
        harness: {
          ...getHarness("claude"),
          install: async () => ({ artifacts: [artifact], messages: [] }),
          uninstall: async () => {
            uninstalled = true;
            return { removed: [artifact], retained: [], messages: [] };
          },
        },
        getInstallation: () => existing,
        writeInstallation: () => {
          throw new Error("disk is read-only");
        },
      }),
    ).rejects.toThrow(/existing registration was left unchanged/);
    expect(uninstalled).toBe(false);
  });

  test("names manual cleanup when inventory persistence and rollback fail", async () => {
    const artifact = {
      kind: "mcp-json" as const,
      path: "/tmp/opencode.json",
      server_name: "me" as const,
    };
    await expect(
      installHarness("opencode", {
        harness: {
          ...getHarness("opencode"),
          install: async () => ({ artifacts: [artifact], messages: [] }),
          uninstall: async () => {
            throw new Error("provider unavailable");
          },
        },
        writeInstallation: () => {
          throw new Error("disk is read-only");
        },
      }),
    ).rejects.toThrow(/remove mcp\.me from \/tmp\/opencode\.json/);
  });
});
