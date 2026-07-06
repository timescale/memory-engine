import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryClient } from "../client.ts";
import {
  DEFAULT_SERVER,
  DEV_SERVER,
  type ResolvedCredentials,
} from "../credentials.ts";
import { resetKeychainForTests } from "../keychain.ts";
import { resetProjectConfigCache } from "../project-config.ts";
import { buildOptions, createSessionRouter } from "./import.ts";

describe("buildOptions", () => {
  test("defaults to the PRIVATE tree root and agent_sessions node name", () => {
    const config = buildOptions({});

    expect(config.write.treeRoot).toBe("~/projects");
    expect(config.write.sessionsNodeName).toBe("agent_sessions");
  });

  test("accepts a custom sessions node name", () => {
    const config = buildOptions({ sessionsNodeName: "sessions" });

    expect(config.write.sessionsNodeName).toBe("sessions");
  });

  test("rejects invalid sessions node names", () => {
    expect(() => buildOptions({ sessionsNodeName: "agent-sessions" })).toThrow(
      "Invalid --sessions-node-name: 'agent-sessions'. Must match [a-z0-9_]+",
    );
  });

  test("accepts a ~ (home) tree root and other lenient forms", () => {
    expect(buildOptions({ treeRoot: "~" }).write.treeRoot).toBe("~");
    expect(buildOptions({ treeRoot: "~.work" }).write.treeRoot).toBe("~.work");
    expect(buildOptions({ treeRoot: "~/work" }).write.treeRoot).toBe("~/work");
    expect(buildOptions({ treeRoot: "share.projects" }).write.treeRoot).toBe(
      "share.projects",
    );
  });

  test("rejects a tree root with illegal characters", () => {
    expect(() => buildOptions({ treeRoot: "bad space" })).toThrow(
      "Invalid --tree-root",
    );
  });

  test("never sets a run-level tree — per-session routing owns .me trees", () => {
    // Even a --project-scoped run leaves write.tree unset: the router
    // resolves each session's own project `.me` (see createSessionRouter
    // tests below), so buildOptions only computes the run-level parent.
    expect(buildOptions({ project: "/repo" }).write.tree).toBeUndefined();
    expect(buildOptions({}).write.tree).toBeUndefined();
  });

  test("a machine-wide tree_root (creds.treeRoot) replaces the default parent", () => {
    const config = buildOptions({}, { treeRoot: "~/work" });
    expect(config.write.treeRoot).toBe("~/work");
    // An explicit --tree-root still wins over it.
    expect(
      buildOptions({ treeRoot: "share.work" }, { treeRoot: "~/work" }).write
        .treeRoot,
    ).toBe("share.work");
  });
});

// =============================================================================
// createSessionRouter — per-project resolution through the real local stack
// =============================================================================

const ROUTER_ENVS = [
  "ME_SESSION_TOKEN",
  "ME_SPACE",
  "ME_SERVER",
  "ME_API_KEY",
  "ME_AS_AGENT",
  "XDG_CONFIG_HOME",
  "ME_NO_KEYCHAIN",
  "ME_CONFIG_DIR",
];

describe("createSessionRouter", () => {
  let configDir: string;
  let projectsDir: string;
  let savedEnv: Record<string, string | undefined>;

  /** A project dir, optionally with a `.me/config.yaml`. */
  function project(name: string, me?: string): string {
    const dir = join(projectsDir, name);
    mkdirSync(dir, { recursive: true });
    if (me !== undefined) {
      mkdirSync(join(dir, ".me"), { recursive: true });
      writeFileSync(join(dir, ".me", "config.yaml"), me);
    }
    return dir;
  }

  /** Sentinel base engine + creds (logged in via ME_SESSION_TOKEN). */
  function makeBase(over: Partial<ResolvedCredentials> = {}) {
    const engine = { __base: true } as unknown as MemoryClient;
    const creds: ResolvedCredentials = {
      server: DEFAULT_SERVER,
      loggedIn: true,
      activeSpace: "basespace0001",
      captureEnabled: false,
      ...over,
    };
    return { creds, engine };
  }

  /** An injected client factory that records each build. */
  function makeFactory() {
    const built: Array<{ server: string; space: string }> = [];
    const buildClient = (c: ResolvedCredentials & { activeSpace: string }) => {
      built.push({ server: c.server, space: c.activeSpace });
      return { __built: built.length } as unknown as MemoryClient;
    };
    return { built, buildClient };
  }

  beforeEach(() => {
    savedEnv = {};
    for (const k of ROUTER_ENVS) savedEnv[k] = process.env[k];
    configDir = mkdtempSync(join(tmpdir(), "me-router-cfg-"));
    projectsDir = mkdtempSync(join(tmpdir(), "me-router-proj-"));
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.ME_NO_KEYCHAIN = "1";
    for (const k of ["ME_SPACE", "ME_SERVER", "ME_API_KEY", "ME_AS_AGENT"]) {
      delete process.env[k];
    }
    delete process.env.ME_CONFIG_DIR;
    // The raw-bearer override marks every server logged-in — the common case
    // for a sweep; the no-credentials test clears it.
    process.env.ME_SESSION_TOKEN = "raw-bearer";
    // Global config: an active space for the base server only.
    mkdirSync(join(configDir, "me"), { recursive: true });
    writeFileSync(
      join(configDir, "me", "config.yaml"),
      `default_server: ${DEFAULT_SERVER}\nservers:\n  ${DEFAULT_SERVER}:\n    active_space: basespace0001\n`,
    );
    resetKeychainForTests();
    resetProjectConfigCache();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
    for (const k of ROUTER_ENVS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetKeychainForTests();
    resetProjectConfigCache();
  });

  test("no cwd → the base route", async () => {
    const base = makeBase();
    const router = createSessionRouter({ base });
    const d = await router(undefined);
    if ("skip" in d) throw new Error("expected route");
    expect(d.route.engine).toBe(base.engine);
    expect(d.route.tree).toBeUndefined();
    expect(d.route.treeRoot).toBe("~/projects");
  });

  test("a cwd without .me gets its own client for the base target", async () => {
    const base = makeBase();
    const { built, buildClient } = makeFactory();
    const router = createSessionRouter({ base, buildClient });
    const d = await router(project("plain"));
    if ("skip" in d) throw new Error("expected route");
    // Always a client from the project's own creds — never a reused one:
    // the client carries the identity (asAgent), which can vary per project.
    expect(d.route.engine).not.toBe(base.engine);
    expect(d.route.tree).toBeUndefined();
    expect(built).toEqual([{ server: DEFAULT_SERVER, space: "basespace0001" }]);
  });

  test("a project .me tree routes the session under it", async () => {
    const base = makeBase();
    const { built, buildClient } = makeFactory();
    const router = createSessionRouter({ base, buildClient });
    const d = await router(project("treed", "tree: /share/projects/treed\n"));
    if ("skip" in d) throw new Error("expected route");
    expect(d.route.tree).toBe("/share/projects/treed");
    expect(built).toHaveLength(1);
  });

  test("a project pinning another space gets its own client, memoized per cwd", async () => {
    const base = makeBase();
    const { built, buildClient } = makeFactory();
    const router = createSessionRouter({ base, buildClient });
    const dir = project("otherspace", "space: teamspace0001\n");
    const d1 = await router(dir);
    const d2 = await router(dir);
    if ("skip" in d1 || "skip" in d2) throw new Error("expected routes");
    expect(built).toEqual([{ server: DEFAULT_SERVER, space: "teamspace0001" }]);
    expect(d1.route.engine).toBe(d2.route.engine);
    expect(d1.route.engine).not.toBe(base.engine);
  });

  test("a project pinning another (whitelisted) server routes there", async () => {
    const base = makeBase();
    const { built, buildClient } = makeFactory();
    const router = createSessionRouter({ base, buildClient });
    const d = await router(
      project("dev", `server: ${DEV_SERVER}\nspace: devspace000001\n`),
    );
    if ("skip" in d) throw new Error("expected route");
    expect(built).toEqual([{ server: DEV_SERVER, space: "devspace000001" }]);
  });

  test("an untrusted .me server skips the session (credential-safety gate)", async () => {
    const base = makeBase();
    const router = createSessionRouter({ base });
    const d = await router(
      project("evil", "server: https://attacker.example\n"),
    );
    expect(d).toMatchObject({ skip: "project_config_error" });
    if (!("skip" in d)) throw new Error("expected skip");
    expect(d.detail).toContain("trusted server list");
  });

  test("a malformed .me skips the session instead of killing the sweep", async () => {
    const base = makeBase();
    const router = createSessionRouter({ base });
    const d = await router(project("broken", "tree: has spaces\n"));
    expect(d).toMatchObject({ skip: "project_config_error" });
  });

  test(".me agent sentinel: the project's agent rides on its client", async () => {
    process.env.ME_AS_AGENT = ".me";
    const base = makeBase({ asAgent: "runner-agent" });
    const captured: Array<string | undefined> = [];
    const buildClient = (c: ResolvedCredentials & { activeSpace: string }) => {
      captured.push(c.asAgent);
      return { __built: captured.length } as unknown as MemoryClient;
    };
    const router = createSessionRouter({ base, buildClient });
    const d = await router(project("agented", "agent: repo-a-agent\n"));
    if ("skip" in d) throw new Error("expected route");
    expect(captured).toEqual(["repo-a-agent"]);
  });

  test(".me agent sentinel with no project agent skips (never kills the sweep)", async () => {
    process.env.ME_AS_AGENT = ".me";
    const base = makeBase({ asAgent: "runner-agent" });
    const router = createSessionRouter({ base });
    const d = await router(project("agentless"));
    expect(d).toMatchObject({ skip: "project_config_error" });
    if (!("skip" in d)) throw new Error("expected skip");
    expect(d.detail).toContain("agent");
  });

  test("no credentials for the project's server → skip", async () => {
    delete process.env.ME_SESSION_TOKEN; // no raw override, nothing stored
    const base = makeBase(); // base creds fabricated as logged-in
    const router = createSessionRouter({ base });
    const d = await router(
      project("devnocreds", `server: ${DEV_SERVER}\nspace: devspace000001\n`),
    );
    expect(d).toEqual({ skip: "no_credentials_for_server" });
  });

  test("no space resolvable for the project → skip", async () => {
    const base = makeBase();
    const router = createSessionRouter({ base });
    // DEV server has no stored active_space and the .me pins no space.
    const d = await router(project("nospace", `server: ${DEV_SERVER}\n`));
    expect(d).toEqual({ skip: "no_space_for_project" });
  });

  test("an explicit --tree-root wins over every project's .me tree", async () => {
    const base = makeBase();
    const router = createSessionRouter({
      base,
      explicitTreeRoot: "share.work",
    });
    const d = await router(project("t2", "tree: /share/projects/t2\n"));
    if ("skip" in d) throw new Error("expected route");
    expect(d.route.tree).toBeUndefined();
    expect(d.route.treeRoot).toBe("share.work");
  });
});
