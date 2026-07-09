/**
 * Tests for removeClaudeSettingsEnvKey — `me project init` uses this to
 * clean up a stale `ME_AS_AGENT` pin now that agent-by-config resolves it
 * from `.me/config.yaml` instead.
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
import { removeClaudeSettingsEnvKey } from "./settings.ts";

let root: string;

const settingsPath = () => join(root, ".claude", "settings.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf-8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "me-claude-settings-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ env: { OTHER: "kept" } }));
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
