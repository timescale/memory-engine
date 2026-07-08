/**
 * Tests for the `.claude/settings.json` env writer/remover: writeClaudeSettingsEnv
 * (general-purpose merge-into-env) and removeClaudeSettingsEnvKey, which
 * `me project init` uses to clean up a stale `ME_AS_AGENT` pin now that
 * agent-by-config resolves it from `.me/config.yaml` instead.
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
import {
  removeClaudeSettingsEnvKey,
  writeClaudeSettingsEnv,
} from "./settings.ts";

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

// =============================================================================
// removeClaudeSettingsEnvKey
// =============================================================================

test("removes the key, preserving other env entries and top-level keys", () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      env: { OTHER: "kept", ME_AS_AGENT: "stale-agent" },
    }),
  );
  expect(removeClaudeSettingsEnvKey(root, "ME_AS_AGENT")).toBe(true);
  expect(readSettings()).toEqual({
    permissions: { allow: ["Bash(ls:*)"] },
    env: { OTHER: "kept" },
  });
});

test("returns false and does nothing when the file is absent", () => {
  expect(removeClaudeSettingsEnvKey(root, "ME_AS_AGENT")).toBe(false);
  expect(existsSync(settingsPath())).toBe(false);
});

test("returns false and does nothing when the key isn't in env", () => {
  writeClaudeSettingsEnv(root, { OTHER: "kept" });
  expect(removeClaudeSettingsEnvKey(root, "ME_AS_AGENT")).toBe(false);
  expect(readSettings()).toEqual({ env: { OTHER: "kept" } });
});

test("returns false and does nothing when there is no env map at all", () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ permissions: {} }));
  expect(removeClaudeSettingsEnvKey(root, "ME_AS_AGENT")).toBe(false);
  expect(readSettings()).toEqual({ permissions: {} });
});

test("returns false on a malformed file rather than compounding the problem", () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), "{ not json");
  expect(removeClaudeSettingsEnvKey(root, "ME_AS_AGENT")).toBe(false);
  expect(readFileSync(settingsPath(), "utf-8")).toBe("{ not json");
});
