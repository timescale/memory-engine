import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  canonicalizeDirectory,
  writeDefaults,
  writeDirectoryProfile,
} from "../local-config.ts";
import { createDoctorCommand } from "./doctor.ts";

const SERVER = "https://api.example.com";

let configHome: string;
let root: string;
let savedXdg: string | undefined;
let savedAgent: string | undefined;
let savedProjectDir: string | undefined;
let savedClaudeProjectDir: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedAgent = process.env.AI_AGENT;
  savedProjectDir = process.env.ME_PROJECT_DIR;
  savedClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  configHome = mkdtempSync(join(tmpdir(), "me-doctor-config-"));
  root = mkdtempSync(join(tmpdir(), "me-doctor-root-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.AI_AGENT;
  delete process.env.ME_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedAgent === undefined) delete process.env.AI_AGENT;
  else process.env.AI_AGENT = savedAgent;
  if (savedProjectDir === undefined) delete process.env.ME_PROJECT_DIR;
  else process.env.ME_PROJECT_DIR = savedProjectDir;
  if (savedClaudeProjectDir === undefined)
    delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedClaudeProjectDir;
});

// Run `me doctor` with `--json` and return the parsed structured output. The
// action emits JSON via process.stdout.write synchronously (before the first
// await inside output()), so capturing that write is sufficient.
async function runDoctor(args: string[]) {
  const program = new Command();
  program.option("--json").option("--yaml");
  program.addCommand(createDoctorCommand());
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["node", "me", "--json", "doctor", ...args]);
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(chunks.join(""));
}

function makeDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("MCP inactivity is explained by mcp.enabled: false in the matched directory profile", async () => {
  const dir = makeDir("proj");
  writeDirectoryProfile(dir, {
    mcp: { enabled: false, harnesses: {} },
    capture: {
      enabled: true,
      server: SERVER,
      space: "capturespace",
      tree: "/share/projects/proj",
      harnesses: { claude: true },
    },
  });

  const out = await runDoctor([dir]);

  expect(out.profile_source).toBe("directory");
  expect(out.surfaces.mcp.active).toBe(false);
  expect(out.surfaces.mcp.reason).toContain("`mcp.enabled` is false");
  expect(out.surfaces.mcp.reason).toContain(canonicalizeDirectory(dir));
});

test("capture inactivity is explained when no directory profile matches and defaults omit it", async () => {
  writeDefaults({ mcp: { enabled: false, harnesses: {} } });
  const dir = makeDir("unconfigured");

  const out = await runDoctor([dir]);

  expect(out.profile_source).toBe("defaults");
  expect(out.surfaces.capture.active).toBe(false);
  expect(out.surfaces.capture.reason).toContain(
    "no matched directory profile exists",
  );
  expect(out.surfaces.capture.reason).toContain("defaults");
});

test("an active surface reports its selected harnesses, server, and space mode", async () => {
  const dir = makeDir("proj");
  writeDirectoryProfile(dir, {
    mcp: {
      enabled: true,
      server: SERVER,
      harnesses: { claude: true, opencode: true },
    },
    capture: {
      enabled: true,
      server: SERVER,
      space: "capturespace",
      tree: "/share/projects/proj",
      harnesses: { claude: true },
    },
  });

  const out = await runDoctor([dir]);

  expect(out.surfaces.mcp.active).toBe(true);
  expect(out.surfaces.mcp.harnesses).toEqual(["claude", "opencode"]);
  expect(out.surfaces.mcp.server).toBe(SERVER);
  // No space pinned → multi-space MCP.
  expect(out.surfaces.mcp.multiSpace).toBe(true);
  expect(out.surfaces.mcp.space).toBeUndefined();

  expect(out.surfaces.capture.active).toBe(true);
  expect(out.surfaces.capture.harnesses).toEqual(["claude"]);
  expect(out.surfaces.capture.space).toBe("capturespace");
  expect(out.surfaces.capture.tree).toBe("/share/projects/proj");
});

test("CLI-in-harness routing reflects the current AI_AGENT context", async () => {
  const dir = makeDir("proj");
  writeDirectoryProfile(dir, {
    cli: { server: SERVER, space: "clispace", harnesses: { claude: true } },
  });

  // No harness context: the cli surface is reported but not routed.
  let out = await runDoctor([dir]);
  expect(out.surfaces.cli.configured).toBe(true);
  expect(out.surfaces.cli.harnesses).toEqual(["claude"]);
  expect(out.harnessContext.cliRouting.inHarness).toBe(false);
  expect(out.harnessContext.cliRouting.note).toContain(
    "user CLI is never retargeted",
  );

  // Harness selected under cli.harnesses → routed to the cli block.
  process.env.AI_AGENT = "claude";
  out = await runDoctor([dir]);
  expect(out.harnessContext.cliRouting).toMatchObject({
    inHarness: true,
    agent: "claude",
    routed: true,
    server: SERVER,
    space: "clispace",
  });

  // Harness present but not selected → falls back to user CLI.
  process.env.AI_AGENT = "codex";
  out = await runDoctor([dir]);
  expect(out.harnessContext.cliRouting).toMatchObject({
    inHarness: true,
    agent: "codex",
    routed: false,
  });
  expect(out.harnessContext.cliRouting.note).toContain(
    "falls back to user CLI",
  );
});

test("the resolution anchor is ME_PROJECT_DIR by default, overridden by an explicit argument", async () => {
  const dir = makeDir("proj");

  const explicit = await runDoctor([dir]);
  expect(explicit.anchor.source).toBe("argument");
  expect(explicit.anchor.canonical).toBe(canonicalizeDirectory(dir));

  process.env.ME_PROJECT_DIR = dir;
  const anchored = await runDoctor([]);
  expect(anchored.anchor.source).toBe("ME_PROJECT_DIR");
  expect(anchored.anchor.canonical).toBe(canonicalizeDirectory(dir));
});

test("managed MCP diagnosis uses the same Claude fallback as the dispatcher", async () => {
  const cwd = makeDir("mcp-cwd");
  const claudeProject = makeDir("claude-project");
  writeDirectoryProfile(claudeProject, {
    mcp: { enabled: true, server: SERVER, harnesses: { claude: true } },
  });
  process.env.CLAUDE_PROJECT_DIR = claudeProject;

  const out = await runDoctor(["--harness", "claude", cwd]);

  expect(out.mcp_anchor).toMatchObject({
    harness: "claude",
    source: "CLAUDE_PROJECT_DIR",
    canonical: canonicalizeDirectory(claudeProject),
  });
  expect(out.surfaces.mcp).toMatchObject({ active: true, server: SERVER });
});
