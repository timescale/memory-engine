/**
 * Unit tests for MCP install helpers.
 */
import { describe, expect, test } from "bun:test";
import { buildMeCommand } from "./install.ts";

describe("buildMeCommand", () => {
  test("uses bare 'me' command on PATH", () => {
    const cmd = buildMeCommand("test-key-123", "https://memory.build");
    expect(cmd[0]).toBe("me");
    expect(cmd[1]).toBe("mcp");
  });

  test("includes --api-key and --server with correct values", () => {
    const cmd = buildMeCommand("k", "https://example.com");
    expect(cmd).toEqual([
      "me",
      "mcp",
      "--api-key",
      "k",
      "--server",
      "https://example.com",
    ]);
  });
});
