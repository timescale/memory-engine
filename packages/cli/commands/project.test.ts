/**
 * Tests for `me project init`'s retired-command redirect
 * (`createRemovedCommand`). The prompt flow itself is interactive (clack) and
 * exercised manually.
 */
import { describe, expect, test } from "bun:test";
import { createRemovedCommand } from "./project.ts";

describe("createRemovedCommand", () => {
  test("accepts any legacy flags, then errors and exits 1 without running anything", async () => {
    const cmd = createRemovedCommand("me claude init");
    const originalExit = process.exit;
    const originalError = console.error;
    const calls: { exitCode?: number; message?: string } = {};
    process.exit = ((code?: number) => {
      calls.exitCode = code;
    }) as never;
    console.error = (msg: string) => {
      calls.message = msg;
    };
    try {
      // A mix of flags no longer registered anywhere on this command —
      // Commander must not reject these itself (allowUnknownOption /
      // allowExcessArguments), or the action below never runs.
      await cmd.parseAsync(
        ["--scope", "project", "--skip-mcp-install", "--totally-unknown-flag"],
        { from: "user" },
      );
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
    expect(calls.exitCode).toBe(1);
    expect(calls.message).toContain("me claude init");
    expect(calls.message).toContain("has been removed");
    expect(calls.message).toContain("me project init");
  });
});
