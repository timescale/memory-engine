import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installOpenCodeIntegration,
  uninstallOpenCodeIntegration,
} from "./integration.ts";
import { PLUGIN_MARKER, renderPluginSource } from "./plugin-template.ts";

function paths() {
  const directory = mkdtempSync(join(tmpdir(), "me-opencode-integration-"));
  return {
    configPath: join(directory, "opencode.json"),
    pluginPath: join(directory, "plugins", "memory-engine.ts"),
  };
}

describe("OpenCode integration adapter", () => {
  test("installs only the exact global MCP entry and generated plugin", async () => {
    const target = paths();
    const result = await installOpenCodeIntegration(target);
    expect(JSON.parse(readFileSync(target.configPath, "utf8"))).toEqual({
      mcp: {
        me: {
          type: "local",
          command: ["me", "mcp", "--harness", "opencode"],
        },
      },
    });
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0]).toMatchObject({
      kind: "mcp-json",
      server_name: "me",
    });
    expect(result.artifacts[1]).toMatchObject({
      kind: "file",
      path: target.pluginPath,
    });
    expect(readFileSync(target.pluginPath, "utf8")).not.toContain(
      "memory-recall",
    );
  });

  test("does not write an unrequested repository config path", async () => {
    const target = paths();
    const repositoryConfig = join(
      target.configPath,
      "..",
      "repository",
      "opencode.json",
    );
    await installOpenCodeIntegration(target);
    expect(() => readFileSync(repositoryConfig)).toThrow();
  });

  test("reinstall preserves an existing dormant entry", async () => {
    const target = paths();
    const first = await installOpenCodeIntegration(target);
    const second = await installOpenCodeIntegration(target, {
      installed_at: "2026-08-03T14:00:00.000Z",
      me_version: "0.0.0",
      artifacts: first.artifacts,
    });
    expect(second.artifacts).toHaveLength(2);
    expect(second.artifacts.map((artifact) => artifact.kind)).toEqual([
      "mcp-json",
      "file",
    ]);
    await uninstallOpenCodeIntegration(first.artifacts);
  });

  test("upgrades a recorded v5 plugin to the current template", async () => {
    const target = paths();
    const first = await installOpenCodeIntegration(target);
    const legacy = renderPluginSource().replace(
      PLUGIN_MARKER,
      "// memory-engine: OpenCode dormant plugin (managed by `me opencode install`) v5",
    );
    writeFileSync(target.pluginPath, legacy);

    await installOpenCodeIntegration(target, {
      installed_at: "2026-08-03T14:00:00.000Z",
      me_version: "0.6.2",
      artifacts: first.artifacts,
    });

    expect(readFileSync(target.pluginPath, "utf8")).toBe(renderPluginSource());
  });

  test("rejects the retired bare MCP entry even when it was recorded", async () => {
    const target = paths();
    mkdirSync(join(target.pluginPath, ".."), { recursive: true });
    writeFileSync(
      target.configPath,
      JSON.stringify({
        mcp: { me: { type: "local", command: ["me", "mcp"] } },
      }),
    );

    await expect(
      installOpenCodeIntegration(target, {
        installed_at: "2026-08-04T00:00:00.000Z",
        me_version: "0.0.0",
        artifacts: [
          {
            kind: "mcp-json",
            path: target.configPath,
            server_name: "me",
          },
        ],
      }),
    ).rejects.toThrow("user-owned");
  });

  test("does not reuse an MCP artifact from another config path", async () => {
    const target = paths();
    const first = await installOpenCodeIntegration(target);
    const plugin = first.artifacts.find((artifact) => artifact.kind === "file");
    const mcp = first.artifacts.find(
      (artifact) => artifact.kind === "mcp-json",
    );
    if (!plugin || !mcp)
      throw new Error("missing OpenCode installation artifacts");

    await expect(
      installOpenCodeIntegration(target, {
        installed_at: "2026-08-03T14:00:00.000Z",
        me_version: "0.0.0",
        artifacts: [
          { ...mcp, path: join(target.configPath, "..", "other.json") },
          plugin,
        ],
      }),
    ).rejects.toThrow("unrecorded");
  });

  test("refuses to overwrite an unmanaged plugin", async () => {
    const target = paths();
    mkdirSync(join(target.pluginPath, ".."), { recursive: true });
    writeFileSync(target.pluginPath, "user plugin");

    await expect(installOpenCodeIntegration(target)).rejects.toThrow(
      "user-owned",
    );
    expect(() => readFileSync(target.configPath)).toThrow();
    expect(readFileSync(target.pluginPath, "utf8")).toBe("user plugin");
  });

  test("uninstall preserves unrelated config and removes an empty mcp object", async () => {
    const target = paths();
    writeFileSync(target.configPath, JSON.stringify({ theme: "dark" }));
    const result = await installOpenCodeIntegration(target);
    await uninstallOpenCodeIntegration(result.artifacts);
    expect(JSON.parse(readFileSync(target.configPath, "utf8"))).toEqual({
      theme: "dark",
    });
  });

  test("uninstall removes a recorded legacy bare MCP entry", async () => {
    const target = paths();
    writeFileSync(
      target.configPath,
      JSON.stringify({
        theme: "dark",
        mcp: { me: { type: "local", command: ["me", "mcp"] } },
      }),
    );
    const artifact = {
      kind: "mcp-json" as const,
      path: target.configPath,
      server_name: "me" as const,
    };

    const result = await uninstallOpenCodeIntegration([artifact]);

    expect(result.removed).toEqual([artifact]);
    expect(result.retained).toEqual([]);
    expect(JSON.parse(readFileSync(target.configPath, "utf8"))).toEqual({
      theme: "dark",
    });
  });

  test("retains a modified generated plugin", async () => {
    const target = paths();
    const result = await installOpenCodeIntegration(target);
    writeFileSync(target.pluginPath, "modified");
    const removed = await uninstallOpenCodeIntegration(result.artifacts);
    expect(removed.retained).toHaveLength(1);
    expect(readFileSync(target.pluginPath, "utf8")).toBe("modified");
  });

  test("treats an absent generated plugin as already removed", async () => {
    const target = paths();
    const result = await installOpenCodeIntegration(target);
    const file = result.artifacts.find((artifact) => artifact.kind === "file");
    if (!file) throw new Error("missing file artifact");
    await Bun.file(target.pluginPath).delete();

    const removed = await uninstallOpenCodeIntegration([file]);
    expect(removed.removed).toEqual([file]);
    expect(removed.retained).toEqual([]);
  });
});
