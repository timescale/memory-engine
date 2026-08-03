import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installOpenCodeIntegration,
  uninstallOpenCodeIntegration,
} from "./integration.ts";

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
      mcp: { me: { type: "local", command: ["me", "mcp"] } },
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
    const second = await installOpenCodeIntegration(target);
    expect(second.artifacts).toHaveLength(1);
    expect(second.artifacts[0]?.kind).toBe("file");
    await uninstallOpenCodeIntegration(first.artifacts);
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

  test("retains a modified generated plugin", async () => {
    const target = paths();
    const result = await installOpenCodeIntegration(target);
    writeFileSync(target.pluginPath, "modified");
    const removed = await uninstallOpenCodeIntegration(result.artifacts);
    expect(removed.retained).toHaveLength(1);
    expect(readFileSync(target.pluginPath, "utf8")).toBe("modified");
  });
});
