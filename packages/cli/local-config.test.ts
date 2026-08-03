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
    cli: { server: "https://api.example", harnesses: { gemini: true } },
  });

  const resolved = resolveHarnessProfile(project);
  expect(resolved.mcp.value?.harnesses.claude).toBe(true);
  expect(resolved.capture.value?.harnesses.opencode).toBe(true);
  expect(resolveHarnessCliProfile(project, "gemini").source).toBe("directory");
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
  });
  expect(resolveMcpProfile(root).value?.enabled).toBe(false);
  expect(resolveCaptureProfile(root).value?.enabled).toBe(false);
});

test("writers preserve human CLI state and migrate retired capture fields safely", () => {
  writeConfig(
    [
      "default_server: https://human.example",
      "servers:",
      "  https://human.example:",
      "    active_space: human-space",
      "server_whitelist:",
      "  - https://internal.example",
      "capture: true",
      "tree_root: /share/legacy",
      "unrelated: preserved",
    ].join("\n"),
  );

  writeDirectoryProfile(join(root, "future", "..", "project"), profile());

  const written = readFileSync(configPath(), "utf-8");
  expect(written).toContain("default_server: https://human.example");
  expect(written).toContain("active_space: human-space");
  expect(written).toContain("- https://internal.example");
  expect(written).toContain("unrelated: preserved");
  expect(written).not.toContain("capture: true");
  const config = readLocalConfig();
  expect(config.defaults?.capture).toMatchObject({
    enabled: false,
    tree_root: "/share/legacy",
  });
  expect(
    config.directories[join(canonicalizeDirectory(root), "project")],
  ).toBeDefined();
});

test("removing a harness prunes empty surfaces and profiles", () => {
  const project = join(root, "project");
  mkdirSync(project);
  writeDirectoryProfile(project, profile());
  removeHarnessFromProfiles("claude");
  expect(readLocalConfig().directories).toEqual({});
});
