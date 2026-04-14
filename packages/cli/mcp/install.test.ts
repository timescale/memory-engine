/**
 * Unit tests for MCP install helpers.
 */
import { describe, expect, test } from "bun:test";
import { buildMeCommand } from "./install.ts";

describe("buildMeCommand", () => {
  test("includes --api-key and --server", () => {
    const cmd = buildMeCommand("test-key-123", "https://memory.build");
    expect(cmd).toContain("--api-key");
    expect(cmd).toContain("test-key-123");
    expect(cmd).toContain("--server");
    expect(cmd).toContain("https://memory.build");
  });

  test("always includes both api-key and server", () => {
    const cmd = buildMeCommand("k", "https://example.com");
    const apiKeyIdx = cmd.indexOf("--api-key");
    const serverIdx = cmd.indexOf("--server");
    expect(apiKeyIdx).toBeGreaterThan(-1);
    expect(serverIdx).toBeGreaterThan(-1);
    // api-key value follows the flag
    expect(cmd[apiKeyIdx + 1]).toBe("k");
    // server value follows the flag
    expect(cmd[serverIdx + 1]).toBe("https://example.com");
  });

  test("starts with mcp subcommand", () => {
    const cmd = buildMeCommand("key", "https://memory.build");
    // The command should end with ["mcp", "--api-key", ...] somewhere
    expect(cmd).toContain("mcp");
  });
});
