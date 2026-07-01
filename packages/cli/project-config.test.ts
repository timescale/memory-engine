/**
 * Tests for the `.me/config.yaml` project-config resolver: walk-up discovery,
 * `--config-dir` override, `.local` per-field override, malformed-file tolerance,
 * schema validation, and the memoized process-wide accessor.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProjectConfig,
  getProjectConfig,
  ProjectConfigError,
  resetProjectConfigCache,
  setConfigDirOverride,
} from "./project-config.ts";

let root: string;

/** Write `.me/config.yaml` (or `.me/config.local.yaml`) under `dir`. */
function writeConfig(dir: string, body: string, local = false): void {
  const meDir = join(dir, ".me");
  mkdirSync(meDir, { recursive: true });
  writeFileSync(join(meDir, local ? "config.local.yaml" : "config.yaml"), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "me-projcfg-"));
  resetProjectConfigCache();
  delete process.env.ME_CONFIG_DIR;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetProjectConfigCache();
  delete process.env.ME_CONFIG_DIR;
});

test("returns undefined when there is no .me in scope", () => {
  const sub = join(root, "a", "b");
  mkdirSync(sub, { recursive: true });
  expect(discoverProjectConfig(sub)).toBeUndefined();
});

test("walks up from a nested dir to the nearest .me/config.yaml", () => {
  writeConfig(root, "server: https://api.example.com\nspace: sp_abc\n");
  const sub = join(root, "packages", "cli");
  mkdirSync(sub, { recursive: true });

  const cfg = discoverProjectConfig(sub);
  expect(cfg?.server).toBe("https://api.example.com");
  expect(cfg?.space).toBe("sp_abc");
  expect(cfg?.dir).toBe(root);
});

test("--config-dir uses that dir's .me directly (no walk-up)", () => {
  writeConfig(root, "space: sp_root\n");
  const other = mkdtempSync(join(tmpdir(), "me-projcfg-other-"));
  writeConfig(other, "space: sp_other\n");
  try {
    // startDir is under `root`, but the explicit configDir wins.
    const cfg = discoverProjectConfig(root, other);
    expect(cfg?.space).toBe("sp_other");
    expect(cfg?.dir).toBe(other);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test(".me/config.local.yaml overrides the committed file per field", () => {
  writeConfig(root, "server: https://committed\nspace: sp_committed\n");
  writeConfig(root, "space: sp_local\n", true);

  const cfg = discoverProjectConfig(root);
  // local overrides space, committed server survives (per-field merge).
  expect(cfg?.space).toBe("sp_local");
  expect(cfg?.server).toBe("https://committed");
});

test("a .local file alone (no committed) is still discovered", () => {
  writeConfig(root, "space: sp_local_only\n", true);
  expect(discoverProjectConfig(root)?.space).toBe("sp_local_only");
});

test("tree + agent fields parse; tree accepts ~ and leading slash", () => {
  writeConfig(root, "tree: ~/projects/foo\nagent: my-agent\n");
  const cfg = discoverProjectConfig(root);
  expect(cfg?.tree).toBe("~/projects/foo");
  expect(cfg?.agent).toBe("my-agent");
});

test("malformed YAML is a fatal ProjectConfigError", () => {
  writeConfig(root, ":\n  - not: valid: yaml: {[}\n");
  expect(() => discoverProjectConfig(root)).toThrow(ProjectConfigError);
});

test("an invalid field type is a fatal ProjectConfigError", () => {
  // tree with a space fails the tree-path shape gate.
  writeConfig(root, "tree: has a space\n");
  expect(() => discoverProjectConfig(root)).toThrow(ProjectConfigError);
});

test("getProjectConfig honors --config-dir override and memoizes", () => {
  writeConfig(root, "space: sp_seed\n");
  setConfigDirOverride(root);
  expect(getProjectConfig()?.space).toBe("sp_seed");

  // Changing the file without re-seeding returns the memoized value.
  writeConfig(root, "space: sp_changed\n");
  expect(getProjectConfig()?.space).toBe("sp_seed");

  // Re-seeding (same as a fresh process) invalidates the cache.
  resetProjectConfigCache();
  setConfigDirOverride(root);
  expect(getProjectConfig()?.space).toBe("sp_changed");
});

test("getProjectConfig reads ME_CONFIG_DIR when no override is set", () => {
  writeConfig(root, "space: sp_env\n");
  process.env.ME_CONFIG_DIR = root;
  expect(getProjectConfig()?.space).toBe("sp_env");
});
