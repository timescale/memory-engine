import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  geminiMcpAddCommand,
  installGeminiIntegration,
  uninstallGeminiIntegration,
} from "./integration.ts";

async function withSettings<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "me-gemini-integration-"));
  try {
    return await run(join(dir, "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Gemini integration adapter", () => {
  test("registers the exact user-global dormant MCP command", () => {
    expect(geminiMcpAddCommand()).toEqual([
      "gemini",
      "mcp",
      "add",
      "--scope",
      "user",
      "me",
      "me",
      "mcp",
    ]);
  });

  test("returns MCP and exact BeforeTool artifacts without static routing", async () => {
    await withSettings(async (path) => {
      const result = await installGeminiIntegration(path, async () => ({
        success: true,
        message: "Registered with Gemini CLI",
      }));
      expect(result.artifacts).toEqual([
        { kind: "mcp-cli", server_name: "me", scope: "user" },
        {
          kind: "json-hook",
          path,
          event: "BeforeTool",
          command: "me gemini env-hook",
        },
      ]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        hooks: {
          BeforeTool: [
            {
              matcher: "run_shell_command",
              hooks: [{ type: "command", command: "me gemini env-hook" }],
            },
          ],
        },
      });
    });
  });

  test("uninstall preserves unrelated Gemini settings and hook entries", async () => {
    await withSettings(async (path) => {
      writeFileSync(
        path,
        JSON.stringify({
          theme: "dark",
          hooks: {
            BeforeTool: [
              {
                matcher: "read_file",
                hooks: [{ type: "command", command: "other" }],
              },
              {
                matcher: "run_shell_command",
                hooks: [{ type: "command", command: "me gemini env-hook" }],
              },
            ],
            AfterTool: [
              { matcher: "*", hooks: [{ type: "command", command: "after" }] },
            ],
          },
        }),
      );
      const mcpArtifact = {
        kind: "mcp-cli" as const,
        server_name: "me" as const,
        scope: "user" as const,
      };
      const hookArtifact = {
        kind: "json-hook" as const,
        path,
        event: "BeforeTool",
        command: "me gemini env-hook",
      };
      const result = await uninstallGeminiIntegration(
        {
          installed_at: "2026-08-03T14:00:00.000Z",
          me_version: "0.0.0",
          artifacts: [mcpArtifact, hookArtifact],
        },
        async () => true,
      );
      expect(result.removed).toEqual([mcpArtifact, hookArtifact]);
      expect(result.retained).toEqual([]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "dark",
        hooks: {
          BeforeTool: [
            {
              matcher: "read_file",
              hooks: [{ type: "command", command: "other" }],
            },
          ],
          AfterTool: [
            { matcher: "*", hooks: [{ type: "command", command: "after" }] },
          ],
        },
      });
    });
  });
});
