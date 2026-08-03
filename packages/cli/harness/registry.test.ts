import { describe, expect, test } from "bun:test";
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
});
