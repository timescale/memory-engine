/**
 * Tests for the unrecognized-payload-shape diagnostic log used by the
 * Codex/Gemini rewrite hooks' fail-open path.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getShapeLogPath,
  logUnrecognizedPayloadShape,
  readShapeLog,
} from "./harness-shape-log.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "me-shapelog-"));
  process.env.XDG_CONFIG_HOME = configDir;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

test("logs sorted top-level keys, never values", () => {
  logUnrecognizedPayloadShape("codex", {
    zeta: "secret-command --token abc123",
    alpha: 1,
    tool_input: { command: "rm -rf /" },
  });
  const [entry] = readShapeLog();
  expect(entry?.harness).toBe("codex");
  expect(entry?.shape).toEqual(["alpha", "tool_input", "zeta"]);
  const raw = readFileSync(getShapeLogPath(), "utf-8");
  expect(raw).not.toContain("secret-command");
  expect(raw).not.toContain("rm -rf");
});

test("describes non-object payloads with a type marker", () => {
  logUnrecognizedPayloadShape("gemini", "not json");
  logUnrecognizedPayloadShape("gemini", null);
  logUnrecognizedPayloadShape("gemini", [1, 2, 3]);
  logUnrecognizedPayloadShape("gemini", undefined);
  const entries = readShapeLog();
  expect(entries.map((e) => e.shape)).toEqual([
    "string",
    "null",
    "array",
    "undefined",
  ]);
});

test("readShapeLog returns [] when the log doesn't exist", () => {
  expect(readShapeLog()).toEqual([]);
});

test("caps the log at the most recent 200 entries", () => {
  for (let i = 0; i < 205; i++) {
    logUnrecognizedPayloadShape("codex", { i });
  }
  const entries = readShapeLog();
  expect(entries).toHaveLength(200);
  // The oldest 5 were dropped; the log keeps the most recent window.
  expect(entries[0]?.shape).toEqual(["i"]);
});

test("a corrupt line is skipped rather than failing the whole read", () => {
  logUnrecognizedPayloadShape("codex", { a: 1 });
  writeFileSync(
    getShapeLogPath(),
    `${readFileSync(getShapeLogPath(), "utf-8").trim()}\nnot json at all\n`,
  );
  logUnrecognizedPayloadShape("codex", { b: 2 });
  const entries = readShapeLog();
  expect(entries).toHaveLength(2);
  expect(entries[0]?.shape).toEqual(["a"]);
  expect(entries[1]?.shape).toEqual(["b"]);
});

test("never throws even if the config dir can't be created (best-effort)", () => {
  // Point XDG_CONFIG_HOME at a path that can't be a directory (a file).
  const blocker = join(configDir, "blocker-file");
  writeFileSync(blocker, "x");
  process.env.XDG_CONFIG_HOME = blocker;
  expect(() => logUnrecognizedPayloadShape("codex", { a: 1 })).not.toThrow();
});
