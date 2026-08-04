import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeDirectory,
  type HarnessProfile,
  readLocalConfig,
  removeHarnessFromProfiles,
  resolveCaptureProfile,
  resolveHarnessCliProfile,
  resolveHarnessProfile,
  resolveMcpProfile,
  writeDefaults,
  writeDirectoryProfile,
} from "./local-config.ts";

let configHome: string;
let root: string;
let savedXdg: string | undefined;

function configPath(): string {
  return join(configHome, "me", "config.yaml");
}

function writeConfig(body: string): void {
  mkdirSync(join(configHome, "me"), { recursive: true });
  writeFileSync(configPath(), body);
}

function profile(server = "https://api.example.com"): HarnessProfile {
  return {
    mcp: { enabled: true, server, harnesses: { claude: true } },
    capture: {
      enabled: true,
      server,
      space: "capturespace",
      tree: "/share/projects/test",
      harnesses: { claude: true },
    },
    cli: { server, space: "clispace", harnesses: { claude: true } },
  };
}

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  configHome = mkdtempSync(join(tmpdir(), "me-local-config-"));
  root = mkdtempSync(join(tmpdir(), "me-local-root-"));
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

test("canonicalizes existing symlinks and normalizes non-existent paths lexically", () => {
  const target = join(root, "target");
  const linked = join(root, "linked");
  mkdirSync(target);
  symlinkSync(target, linked);

  expect(canonicalizeDirectory(join(linked, "."))).toBe(
    canonicalizeDirectory(target),
  );
  expect(canonicalizeDirectory(join(linked, "future", "project"))).toBe(
    join(canonicalizeDirectory(target), "future", "project"),
  );
  expect(canonicalizeDirectory(join(root, "future", "..", "new-project"))).toBe(
    join(canonicalizeDirectory(root), "new-project"),
  );
});

test("uses a segment-aware longest ancestor directory profile", () => {
  const foo = join(root, "foo");
  const foobar = join(root, "foobar");
  mkdirSync(join(foo, "child"), { recursive: true });
  mkdirSync(foobar);
  writeDirectoryProfile(foo, profile("https://foo.example"));
  writeDirectoryProfile(join(foo, "child"), {
    mcp: {
      enabled: true,
      server: "https://child.example",
      harnesses: { claude: true },
    },
  });

  expect(resolveMcpProfile(join(foo, "child")).value?.server).toBe(
    "https://child.example",
  );
  expect(resolveMcpProfile(foobar).source).toBe("disabled");
});

test("matches a root directory profile for descendant paths", () => {
  writeDirectoryProfile("/", {
    mcp: {
      enabled: true,
      server: "https://root.example",
      harnesses: { claude: true },
    },
  });

  expect(resolveMcpProfile(root).value?.server).toBe("https://root.example");
});

test("a directory profile replaces defaults, including omitted surfaces", () => {
  const project = join(root, "project");
  mkdirSync(project);
  writeDefaults({
    mcp: {
      enabled: true,
      server: "https://defaults.example",
      harnesses: { claude: true },
    },
    capture: {
      enabled: true,
      server: "https://defaults.example",
      space: "defaultspace",
      tree_root: "/share/projects",
      harnesses: { claude: true },
    },
  });
  writeDirectoryProfile(project, {
    mcp: {
      enabled: true,
      server: "https://project.example",
      harnesses: { claude: true },
    },
  });

  const resolved = resolveHarnessProfile(project);
  expect(resolved.mcp.value?.server).toBe("https://project.example");
  expect(resolved.capture).toEqual({ source: "disabled" });
  expect(resolveCaptureProfile(join(root, "outside")).source).toBe("defaults");
});

test("harness gates apply independently to mcp, capture, and harness CLI", () => {
  const project = join(root, "project");
  mkdirSync(project);
  writeDirectoryProfile(project, {
    mcp: {
      enabled: true,
      server: "https://api.example",
      harnesses: { claude: true, codex: false },
    },
    capture: {
      enabled: true,
      server: "https://api.example",
      space: "capturespace",
      tree: "/share/projects/test",
      harnesses: { opencode: true },
    },
    cli: { server: "https://api.example", harnesses: { codex: true } },
  });

  const resolved = resolveHarnessProfile(project);
  expect(resolved.mcp.value?.harnesses.claude).toBe(true);
  expect(resolved.capture.value?.harnesses.opencode).toBe(true);
  expect(resolveHarnessCliProfile(project, "codex").source).toBe("directory");
  expect(resolveHarnessCliProfile(project, "claude")).toEqual({
    source: "disabled",
  });
});

test("validates capture destination scope and enabled selection requirements", () => {
  expect(() =>
    writeDefaults({
      capture: {
        enabled: true,
        server: "https://api.example",
        space: "capturespace",
        tree: "/share/projects/test",
        harnesses: { claude: true },
      },
    }),
  ).toThrow(/only valid in a directory profile/);
  expect(() =>
    writeDirectoryProfile(root, {
      capture: {
        enabled: true,
        server: "https://api.example",
        space: "capturespace",
        tree_root: "/share/projects",
        harnesses: { claude: true },
      },
    }),
  ).toThrow(/only valid in defaults/);
  expect(() =>
    writeDefaults({
      mcp: { enabled: true, server: "https://api.example", harnesses: {} },
    }),
  ).toThrow(/at least one selected harness/);
});

test("allows disabled surfaces with retained harness selections", () => {
  writeDefaults({
    mcp: { enabled: false, harnesses: { claude: true } },
    capture: { enabled: false, harnesses: { opencode: true } },
    cli: { harnesses: {} },
  });
  expect(resolveMcpProfile(root).value?.enabled).toBe(false);
  expect(resolveCaptureProfile(root).value?.enabled).toBe(false);
  expect(resolveHarnessCliProfile(root, "claude")).toEqual({
    source: "disabled",
  });
});

test("writers preserve human CLI state and unrelated fields", () => {
  writeConfig(
    [
      "default_server: https://human.example",
      "servers:",
      "  https://human.example:",
      "    active_space: human-space",
      "unrelated: preserved",
    ].join("\n"),
  );

  writeDirectoryProfile(join(root, "future", "..", "project"), profile());

  const written = readFileSync(configPath(), "utf-8");
  expect(written).toContain("default_server: https://human.example");
  expect(written).toContain("active_space: human-space");
  expect(written).toContain("unrelated: preserved");
  const config = readLocalConfig();
  expect(
    config.directories[join(canonicalizeDirectory(root), "project")],
  ).toBeDefined();
});

test("rejects unknown profile and surface keys", () => {
  writeConfig("version: 1\ndefaults:\n  unknown: true\ndirectories: {}\n");
  expect(readLocalConfig).toThrow(/unknown defaults key "unknown"/);

  writeConfig(
    "version: 1\ndefaults:\n  mcp:\n    enabled: false\n    harnesses: {}\n    unknown: true\ndirectories: {}\n",
  );
  expect(readLocalConfig).toThrow(/unknown defaults.mcp key "unknown"/);
});

test("rejects unknown and non-boolean harness selections", () => {
  writeConfig(
    "version: 1\ndefaults:\n  mcp:\n    enabled: false\n    harnesses:\n      unknown: true\ndirectories: {}\n",
  );
  expect(readLocalConfig).toThrow(/unknown harness "unknown"/);

  writeConfig(
    "version: 1\ndefaults:\n  mcp:\n    enabled: false\n    harnesses:\n      claude: yes\ndirectories: {}\n",
  );
  expect(readLocalConfig).toThrow(/harnesses.claude must be a boolean/);
});

test("rejects invalid YAML and unsupported versions", () => {
  writeConfig("defaults: [\n");
  expect(readLocalConfig).toThrow(/could not parse YAML/);

  writeConfig("version: 2\ndirectories: {}\n");
  expect(readLocalConfig).toThrow(/version must be 1/);
});

test("rejects relative and noncanonical directory keys", () => {
  writeConfig("version: 1\ndirectories:\n  relative: {}\n");
  expect(readLocalConfig).toThrow(/absolute canonical path/);

  const canonicalRoot = canonicalizeDirectory(root);
  mkdirSync(join(root, "target"));
  symlinkSync(join(root, "target"), join(root, "alias"));
  writeConfig(`version: 1\ndirectories:\n  ${canonicalRoot}/child/..: {}\n`);
  expect(readLocalConfig).toThrow(/absolute canonical path/);

  writeConfig(`version: 1
directories:
  ${join(root, "alias")}: {}
`);
  expect(readLocalConfig).toThrow(/absolute canonical path/);
});

test("removing a harness prunes empty surfaces and profiles", () => {
  const project = join(root, "project");
  mkdirSync(project);
  writeDirectoryProfile(project, profile());
  removeHarnessFromProfiles("claude");
  expect(readLocalConfig().directories).toEqual({});
});
