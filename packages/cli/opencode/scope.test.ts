/** Tests for user-global OpenCode integration paths. */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { openCodePluginsDir } from "./scope.ts";

describe("OpenCode paths", () => {
  test("uses only the user-global plugin directory", () => {
    expect(openCodePluginsDir()).toBe(
      join(homedir(), ".config", "opencode", "plugins"),
    );
  });
});
