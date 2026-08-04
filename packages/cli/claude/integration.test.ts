import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessInstallation } from "../harness/installations.ts";
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
} from "./integration.ts";

interface Result {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

function dependencies(results: Result[] = []) {
  const commands: string[][] = [];
  return {
    commands,
    dependencies: {
      hasClaude: () => true,
      run: async (command: string[]) => {
        commands.push(command);
        const result = results.shift() ?? { exitCode: 0 };
        return {
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      },
    },
  };
}

const pluginArtifact = {
  kind: "plugin",
  marketplace: "memory-engine",
  plugin: "memory-engine@memory-engine",
} as const;

describe("Claude dormant integration adapter", () => {
  test("installs a user-scoped plugin without runtime configuration", async () => {
    const { commands, dependencies: adapter } = dependencies();

    const result = await installClaudeIntegration("plugin", adapter);

    expect(commands).toEqual([
      [
        "claude",
        "plugin",
        "marketplace",
        "add",
        "--scope",
        "user",
        "timescale/memory-engine",
      ],
      [
        "claude",
        "plugin",
        "install",
        "--scope",
        "user",
        "memory-engine@memory-engine",
      ],
    ]);
    expect(result.artifacts).toEqual([pluginArtifact]);
    expect(commands.flat()).not.toContain("--config");
    expect(commands.flat()).not.toContain("--server");
    expect(commands.flat()).not.toContain("--space");
    expect(commands.flat()).not.toContain("--api-key");
  });

  test("registers the managed Claude MCP command in MCP-only mode", async () => {
    const { commands, dependencies: adapter } = dependencies();

    const result = await installClaudeIntegration("mcp-only", adapter);

    expect(commands).toEqual([
      [
        "claude",
        "mcp",
        "add",
        "--scope",
        "user",
        "me",
        "--",
        "me",
        "mcp",
        "--harness",
        "claude",
      ],
    ]);
    expect(result.artifacts).toEqual([
      { kind: "mcp-cli", server_name: "me", scope: "user" },
    ]);
  });

  test("refuses to claim an existing unrecorded plugin", async () => {
    const { commands, dependencies: adapter } = dependencies([
      { exitCode: 1, stderr: "marketplace already exists" },
      { exitCode: 1, stderr: "plugin already installed" },
    ]);

    await expect(installClaudeIntegration("plugin", adapter)).rejects.toThrow(
      "refusing to claim ownership",
    );
    expect(commands).toHaveLength(2);
  });

  test("preserves the recorded artifact when the plugin already exists", async () => {
    const { dependencies: adapter } = dependencies([
      { exitCode: 1, stderr: "marketplace already exists" },
      { exitCode: 1, stderr: "plugin already installed" },
    ]);
    const existing = {
      installed_at: "2026-08-03T20:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [pluginArtifact],
    } satisfies HarnessInstallation;

    const result = await installClaudeIntegration("plugin", adapter, existing);

    expect(result.artifacts).toEqual(existing.artifacts);
  });

  test("uninstalls only recorded plugin and MCP artifacts", async () => {
    const { commands, dependencies: adapter } = dependencies();
    const mcpArtifact = {
      kind: "mcp-cli",
      server_name: "me",
      scope: "user",
    } as const;
    const record = {
      installed_at: "2026-08-03T20:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [pluginArtifact, mcpArtifact],
    } satisfies HarnessInstallation;

    const result = await uninstallClaudeIntegration(record, adapter);

    expect(commands).toEqual([
      [
        "claude",
        "plugin",
        "uninstall",
        "-y",
        "--scope",
        "user",
        "memory-engine@memory-engine",
      ],
      ["claude", "mcp", "remove", "--scope", "user", "me"],
    ]);
    expect(result.removed).toEqual([pluginArtifact, mcpArtifact]);
    expect(commands.flat()).not.toContain("marketplace");
  });

  test("retains artifacts when native removal fails", async () => {
    const { dependencies: adapter } = dependencies([
      { exitCode: 1, stderr: "plugin is in use" },
    ]);
    const record = {
      installed_at: "2026-08-03T20:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [pluginArtifact],
    } satisfies HarnessInstallation;

    const result = await uninstallClaudeIntegration(record, adapter);

    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([pluginArtifact]);
  });

  test("retains a user-modified recorded file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-claude-integration-"));
    const path = join(dir, "generated.json");
    try {
      writeFileSync(path, "original");
      const artifact = {
        kind: "file" as const,
        path,
        sha256: createHash("sha256").update("original").digest("hex"),
      };
      writeFileSync(path, "modified");
      const record = {
        installed_at: "2026-08-03T20:00:00.000Z",
        me_version: "0.0.0",
        artifacts: [artifact],
      } satisfies HarnessInstallation;

      const result = await uninstallClaudeIntegration(
        record,
        dependencies().dependencies,
      );

      expect(result.removed).toEqual([]);
      expect(result.retained).toEqual([artifact]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
