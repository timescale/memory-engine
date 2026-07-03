/**
 * Tests for the `.me/config.yaml` project-config resolver: walk-up discovery,
 * `--config-dir` override, `.local` per-field override, a fatal error on a
 * malformed file, schema validation, the memoized process-wide accessor, and
 * the effective-scope space writer (`writeProjectSpace`).
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
  discoverProjectConfig,
  getProjectConfig,
  ProjectConfigError,
  resetProjectConfigCache,
  setConfigDirOverride,
  writeProjectSpace,
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

test("capture field parses as a boolean (absent → undefined)", () => {
  writeConfig(root, "capture: true\n");
  expect(discoverProjectConfig(root)?.capture).toBe(true);

  writeConfig(root, "capture: false\n");
  expect(discoverProjectConfig(root)?.capture).toBe(false);

  writeConfig(root, "space: sp_abc\n");
  expect(discoverProjectConfig(root)?.capture).toBeUndefined();
});

test("a non-boolean capture is a fatal ProjectConfigError", () => {
  writeConfig(root, "capture: yes please\n");
  expect(() => discoverProjectConfig(root)).toThrow(ProjectConfigError);
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

test("an unknown/misspelled key is a fatal ProjectConfigError (strict)", () => {
  // A typo'd key must fail loudly, not be silently stripped to a no-op pin.
  writeConfig(root, "serer: https://typo.example\n");
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

// =============================================================================
// writeProjectSpace — the effective-scope space writer
// =============================================================================

/** Read a `.me` file's raw text under `dir`. */
function readRaw(dir: string, local = false): string {
  return readFileSync(
    join(dir, ".me", local ? "config.local.yaml" : "config.yaml"),
    "utf-8",
  );
}

/** Discover, asserting the config exists (writer needs a ProjectConfig). */
function mustDiscover(dir: string) {
  const cfg = discoverProjectConfig(dir);
  expect(cfg).toBeDefined();
  if (!cfg) throw new Error("unreachable");
  return cfg;
}

test("writeProjectSpace updates the committed file when it defines space", () => {
  writeConfig(root, "space: sp_old\ntree: /share/projects/foo\n");
  const path = writeProjectSpace(mustDiscover(root), { space: "sp_new" });
  expect(path).toBe(join(root, ".me", "config.yaml"));
  const cfg = discoverProjectConfig(root);
  expect(cfg?.space).toBe("sp_new");
  expect(cfg?.tree).toBe("/share/projects/foo"); // other fields untouched
  expect(existsSync(join(root, ".me", "config.local.yaml"))).toBe(false);
});

test("writeProjectSpace targets the .local file when it defines space", () => {
  writeConfig(root, "space: sp_committed\n");
  writeConfig(root, "space: sp_local\n", true);
  const path = writeProjectSpace(mustDiscover(root), { space: "sp_new" });
  expect(path).toBe(join(root, ".me", "config.local.yaml"));
  // The committed pin is untouched; the .local override carries the new value.
  expect(readRaw(root)).toContain("sp_committed");
  expect(discoverProjectConfig(root)?.space).toBe("sp_new");
});

test("writeProjectSpace returns undefined when no .me file defines space", () => {
  writeConfig(root, "tree: /share/projects/foo\n");
  writeConfig(root, "server: https://local.example\n", true);
  const path = writeProjectSpace(mustDiscover(root), { space: "sp_new" });
  expect(path).toBeUndefined();
  // Nothing was written — no space appears in either file, no file created.
  expect(readRaw(root)).not.toContain("sp_new");
  expect(readRaw(root, true)).not.toContain("sp_new");
});

test("writeProjectSpace preserves comments and formatting", () => {
  writeConfig(
    root,
    "# pinned by the platform team\nserver: https://api.example.com # prod\nspace: sp_old\n",
  );
  writeProjectSpace(mustDiscover(root), { space: "sp_new" });
  const raw = readRaw(root);
  expect(raw).toContain("# pinned by the platform team");
  expect(raw).toContain("# prod");
  expect(raw).toContain("space: sp_new");
  expect(raw).not.toContain("sp_old");
});

test("writeProjectSpace writes server: only when given", () => {
  writeConfig(root, "space: sp_old\n");
  writeProjectSpace(mustDiscover(root), { space: "sp_a" });
  expect(readRaw(root)).not.toContain("server:");

  writeProjectSpace(mustDiscover(root), {
    space: "sp_b",
    server: "https://other.example.com",
  });
  const cfg = discoverProjectConfig(root);
  expect(cfg?.space).toBe("sp_b");
  expect(cfg?.server).toBe("https://other.example.com");
});

test("writeProjectSpace invalidates the process-wide memo", () => {
  writeConfig(root, "space: sp_before\n");
  setConfigDirOverride(root);
  const project = getProjectConfig();
  expect(project?.space).toBe("sp_before");
  if (!project) throw new Error("unreachable");

  writeProjectSpace(project, { space: "sp_after" });
  // No reset: the writer itself must have dropped the memoized value.
  expect(getProjectConfig()?.space).toBe("sp_after");
});

test("writeProjectSpace surfaces a malformed target as ProjectConfigError", () => {
  writeConfig(root, "space: sp_ok\n");
  const project = mustDiscover(root);
  // Corrupt the file after discovery — the writer re-validates before editing.
  writeConfig(root, ":\n  - not: valid: yaml: {[}\n");
  expect(() => writeProjectSpace(project, { space: "sp_new" })).toThrow(
    ProjectConfigError,
  );
});
