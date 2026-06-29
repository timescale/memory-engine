/**
 * Tests for OpenCode install-scope parsing + path resolution.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  openCodeCommandsDir,
  openCodePluginsDir,
  openCodeSkillsDir,
  parseScope,
} from "./scope.ts";

describe("parseScope", () => {
  test("returns undefined when unset (caller applies its own default)", () => {
    expect(parseScope(undefined)).toBeUndefined();
  });

  test("accepts the two valid scopes", () => {
    expect(parseScope("project")).toBe("project");
    expect(parseScope("user")).toBe("user");
  });

  test("throws on an unknown scope", () => {
    expect(() => parseScope("global")).toThrow(/scope must be one of/);
    expect(() => parseScope("")).toThrow(/scope must be one of/);
  });
});

describe("scoped paths", () => {
  const root = "/repo";

  test("project scope nests under <root>/.opencode", () => {
    expect(openCodePluginsDir("project", root)).toBe(
      join(root, ".opencode", "plugins"),
    );
    expect(openCodeCommandsDir("project", root)).toBe(
      join(root, ".opencode", "commands"),
    );
    expect(openCodeSkillsDir("project", root)).toBe(
      join(root, ".opencode", "skills"),
    );
  });

  test("user scope nests under ~/.config/opencode (ignores projectRoot)", () => {
    const base = join(homedir(), ".config", "opencode");
    expect(openCodePluginsDir("user", root)).toBe(join(base, "plugins"));
    expect(openCodeCommandsDir("user", root)).toBe(join(base, "commands"));
    expect(openCodeSkillsDir("user", root)).toBe(join(base, "skills"));
  });
});
