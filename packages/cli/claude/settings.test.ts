/**
 * Tests for the `.claude/settings.json` env writer used by `me project init`
 * to pin the project agent (`ME_AS_AGENT=<agent name>`) for everything Claude
 * runs in the project.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClaudeSettingsEnv } from "./settings.ts";

let root: string;

const settingsPath = () => join(root, ".claude", "settings.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf-8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "me-claude-settings-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("creates .claude/settings.json (and the dir) from scratch", () => {
  const path = writeClaudeSettingsEnv(root, { ME_AS_AGENT: "proj-agent" });
  expect(path).toBe(settingsPath());
  expect(readSettings()).toEqual({ env: { ME_AS_AGENT: "proj-agent" } });
  // Pretty-printed with a trailing newline (a committed file).
  const raw = readFileSync(settingsPath(), "utf-8");
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw).toContain('  "env"');
});

test("merges into env without clobbering other keys or env entries", () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      env: { OTHER: "kept", ME_AS_AGENT: "old-agent" },
    }),
  );
  writeClaudeSettingsEnv(root, { ME_AS_AGENT: "new-agent" });
  expect(readSettings()).toEqual({
    permissions: { allow: ["Bash(ls:*)"] },
    env: { OTHER: "kept", ME_AS_AGENT: "new-agent" },
  });
});

test("replaces a malformed (non-object) env value", () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ env: "not-an-object" }));
  writeClaudeSettingsEnv(root, { ME_AS_AGENT: "a1" });
  expect(readSettings()).toEqual({ env: { ME_AS_AGENT: "a1" } });
});

test("throws on invalid JSON rather than silently replacing the file", () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), "{ not json");
  expect(() => writeClaudeSettingsEnv(root, { ME_AS_AGENT: "a1" })).toThrow(
    /not valid JSON/,
  );
  // The malformed file is left untouched for the user to inspect.
  expect(readFileSync(settingsPath(), "utf-8")).toBe("{ not json");
});

test("throws when the file holds a non-object (e.g. an array)", () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), "[1, 2]");
  expect(() => writeClaudeSettingsEnv(root, { ME_AS_AGENT: "a1" })).toThrow(
    /JSON object/,
  );
  expect(existsSync(settingsPath())).toBe(true);
});
