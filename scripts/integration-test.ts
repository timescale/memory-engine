#!/usr/bin/env bun
/**
 * me CLI integration test.
 *
 * Drives the `me` binary against a real server (defaults to the dev cluster)
 * to exercise as much of the CLI surface as possible. Creates a dedicated
 * test org + engine per run, tags every server-side artifact with a unique
 * run ID, and tears everything down in `finally` even if the test crashes.
 *
 * Coverage notes:
 *  - Auth, org, engine, invitation, RBAC, memory ops, pack ops are exercised.
 *  - Skipped: `me memory edit` (spawns $EDITOR), `me invitation accept`
 *    (needs a second identity), agent integrations (claude/codex/gemini/
 *    opencode), `me mcp` (long-running stdio), `me serve` (HTTP server),
 *    `me upgrade` (would replace the running binary), `me completions`.
 *
 * Isolation:
 *  - Every child gets a throwaway XDG_CONFIG_HOME so the user's real
 *    `~/.config/me/credentials.yaml` is never touched.
 *  - HOME is left untouched so the OAuth browser launch keeps working.
 *
 * Auth:
 *  - Phase 0 invokes `me login` interactively (browser device flow). After
 *    that, every command inherits the session token written to the temp
 *    creds file.
 *
 * Usage:
 *   ./bun run scripts/integration-test.ts
 *   ME_SERVER=https://me.dev-us-east-1.ops.dev.timescale.com \
 *     ./bun run scripts/integration-test.ts
 *   ./bun run scripts/integration-test.ts --bin /path/to/me
 *
 * Exits 0 on full success, 1 if any step failed.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

type Status = "pass" | "fail" | "skip";

interface StepRecord {
  phase: string;
  command: string;
  status: Status;
  ms: number;
  message?: string;
  exit?: number;
  stderrTail?: string;
}

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  ms: number;
}

interface RunOpts {
  stdin?: string;
  inheritStdio?: boolean;
  /** Extra env vars merged on top of the base env. */
  env?: Record<string, string>;
  /** Don't fail on non-zero exit (caller handles it). */
  allowFail?: boolean;
}

// =============================================================================
// Global state
// =============================================================================

const RUN_ID = `${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
const ORG_NAME = `me-itest-${RUN_ID.replace(/_/g, "-")}`;
const ENGINE_NAME = `itest-${RUN_ID.replace(/_/g, "-")}`;
const TREE_BASE = `itest.${RUN_ID}`;
const PACK_TREE = "pack.me_itest_pack";

const records: StepRecord[] = [];
let currentPhase = "?";

// Environment passed to every child.
let baseEnv: Record<string, string> = {};

let binary = "";
let configDir = "";
let tempRoot = "";
let fixturesDir = "";

// =============================================================================
// CLI argument parsing
// =============================================================================

function parseArgs(): { bin?: string; server?: string } {
  const args = process.argv.slice(2);
  const out: { bin?: string; server?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bin" && args[i + 1]) {
      out.bin = args[++i];
    } else if (a === "--server" && args[i + 1]) {
      out.server = args[++i];
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: integration-test.ts [--bin PATH] [--server URL]\n" +
          "  --bin PATH     path to the `me` binary (default: ME_BIN env, then\n" +
          "                 `me` from PATH)\n" +
          "  --server URL   server URL (default: ME_SERVER env, then dev cluster)\n",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// =============================================================================
// Binary resolution
// =============================================================================

function resolveBinary(flagValue: string | undefined): string {
  if (flagValue) {
    if (!existsSync(flagValue)) {
      throw new Error(`--bin path does not exist: ${flagValue}`);
    }
    return resolve(flagValue);
  }
  if (process.env.ME_BIN) {
    if (!existsSync(process.env.ME_BIN)) {
      throw new Error(`ME_BIN path does not exist: ${process.env.ME_BIN}`);
    }
    return resolve(process.env.ME_BIN);
  }
  // Prefer `me` from PATH (the user's installed copy) over any local
  // `packages/cli/dist/me`. The dist artifact may be a stale or
  // cross-compiled build (e.g. Linux on a macOS host), and silently
  // preferring it produces baffling ENOEXEC errors. Pass --bin or
  // ME_BIN to explicitly target the dist build.
  return "me";
}

// =============================================================================
// Run harness
// =============================================================================

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are exactly what we want to strip here.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

async function run(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const env: Record<string, string> = {
    ...baseEnv,
    ...(opts.env ?? {}),
  };

  const start = performance.now();

  if (opts.inheritStdio) {
    const proc = Bun.spawn([binary, ...args], {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exit = await proc.exited;
    const ms = Math.round(performance.now() - start);
    return { exit, stdout: "", stderr: "", ms };
  }

  const proc = Bun.spawn([binary, ...args], {
    env,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const ms = Math.round(performance.now() - start);
  return { exit, stdout: stdoutText, stderr: stderrText, ms };
}

/**
 * Run a command, parse stdout as JSON, and return the parsed value. Throws
 * with a useful message on non-zero exit or invalid JSON.
 */
async function runJson<T = unknown>(
  args: string[],
  opts: RunOpts = {},
): Promise<{
  exit: number;
  stdout: string;
  stderr: string;
  ms: number;
  json: T;
}> {
  const r = await run(["--json", ...args], opts);
  if (r.exit !== 0) {
    const err = new Error(
      `me ${args.join(" ")} → exit ${r.exit}\n${stripAnsi(r.stderr || r.stdout).slice(-2000)}`,
    );
    (err as Error & { result?: RunResult }).result = r;
    throw err;
  }
  let json: T;
  try {
    json = JSON.parse(r.stdout) as T;
  } catch (e) {
    throw new Error(
      `me ${args.join(" ")} → JSON parse failed: ${(e as Error).message}\nstdout: ${r.stdout.slice(0, 500)}`,
    );
  }
  return { ...r, json };
}

/**
 * Wrap a step in pass/fail tracking. Errors are caught and recorded; the
 * caller continues to the next step so we get a complete coverage picture.
 *
 * If `optional` is true, a failure is recorded as `skip` (best-effort).
 */
async function step(
  command: string,
  fn: () => Promise<void>,
  opts: { optional?: boolean } = {},
): Promise<boolean> {
  const start = performance.now();
  process.stdout.write(`  • ${command} ... `);
  try {
    await fn();
    const ms = Math.round(performance.now() - start);
    records.push({ phase: currentPhase, command, status: "pass", ms });
    process.stdout.write(`\x1b[32mok\x1b[0m (${ms}ms)\n`);
    return true;
  } catch (e) {
    const ms = Math.round(performance.now() - start);
    const err = e as Error & { result?: RunResult };
    const tail = err.result
      ? stripAnsi(err.result.stderr || err.result.stdout)
          .split("\n")
          .filter(Boolean)
          .slice(-10)
          .join("\n")
      : (e as Error).message;
    if (opts.optional) {
      records.push({
        phase: currentPhase,
        command,
        status: "skip",
        ms,
        message: (e as Error).message,
        stderrTail: tail,
      });
      process.stdout.write(
        `\x1b[33mskip\x1b[0m (${ms}ms): ${(e as Error).message.split("\n")[0]}\n`,
      );
    } else {
      records.push({
        phase: currentPhase,
        command,
        status: "fail",
        ms,
        message: (e as Error).message,
        exit: err.result?.exit,
        stderrTail: tail,
      });
      process.stdout.write(
        `\x1b[31mFAIL\x1b[0m (${ms}ms): ${(e as Error).message.split("\n")[0]}\n`,
      );
    }
    return false;
  }
}

function recordSkip(command: string, reason: string): void {
  records.push({
    phase: currentPhase,
    command,
    status: "skip",
    ms: 0,
    message: reason,
  });
  console.log(`  • ${command} ... \x1b[33mskip\x1b[0m: ${reason}`);
}

function header(phase: string, title: string): void {
  currentPhase = phase;
  console.log(`\n\x1b[1m── ${phase} ${title} ──\x1b[0m`);
}

// =============================================================================
// Helpers
// =============================================================================

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function expectEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * Substitute `__RUN_ID__` and `__TREE_BASE__` placeholders in the bundled
 * fixtures and write the result to a tempdir, so each run gets its own
 * isolated tree paths.
 */
function prepareFixtures(): string {
  const srcDir = resolve(import.meta.dir, "integration-test/fixtures");
  const dstDir = join(tempRoot, "fixtures");
  mkdirSync(dstDir, { recursive: true });

  for (const name of [
    "sample.md",
    "sample.yaml",
    "sample.json",
    "sample.ndjson",
  ]) {
    const src = readFileSync(join(srcDir, name), "utf-8");
    const dst = src
      .replaceAll("__RUN_ID__", RUN_ID)
      .replaceAll("__TREE_BASE__", TREE_BASE);
    writeFileSync(join(dstDir, name), dst);
  }

  // Pack fixtures don't need substitution — pack name + tree are fixed.
  writeFileSync(
    join(dstDir, "itest-pack.yaml"),
    readFileSync(join(srcDir, "itest-pack.yaml"), "utf-8"),
  );

  return dstDir;
}

/**
 * Build a "v0.2.0"-bumped copy of the pack to exercise the stale-deletion
 * path of `me pack install`.
 */
function makeBumpedPack(): string {
  const original = readFileSync(join(fixturesDir, "itest-pack.yaml"), "utf-8");
  const bumped = original.replace(/version: "0\.1\.0"/, 'version: "0.2.0"');
  const path = join(tempRoot, "itest-pack-v0.2.0.yaml");
  writeFileSync(path, bumped);
  return path;
}

// =============================================================================
// Phases
// =============================================================================

async function phase0_bootstrap(): Promise<void> {
  header("0", "bootstrap");

  await step("me --version", async () => {
    const r = await run(["--version"]);
    expectEq(r.exit, 0, "exit");
    expect(r.stdout.trim().length > 0, "non-empty version");
  });

  await step("me version --local", async () => {
    const r = await run(["version", "--local"]);
    expectEq(r.exit, 0, "exit");
  });

  await step("me version (server check)", async () => {
    const r = await run(["version"]);
    expectEq(r.exit, 0, "exit");
  });

  await step("me whoami (not logged in)", async () => {
    const r = await run(["--json", "whoami"], { allowFail: true });
    expect(r.exit !== 0, "should fail before login");
    const parsed = JSON.parse(r.stdout) as { error?: string };
    expect(typeof parsed.error === "string", "error field present");
  });

  console.log();
  console.log(
    "\x1b[36m  ── interactive me login ──────────────────────────────────────────\x1b[0m",
  );
  console.log(`  Server: ${baseEnv.ME_SERVER}`);
  console.log(`  XDG_CONFIG_HOME: ${configDir}`);
  console.log("  Complete the OAuth device flow in your browser.");
  console.log();

  await step("me login (interactive)", async () => {
    const r = await run(["login"], { inheritStdio: true });
    if (r.exit !== 0) throw new Error(`login exited ${r.exit}`);
  });

  await step("me whoami --json", async () => {
    const { json } = await runJson<{
      identity: { id: string; name: string; email: string };
    }>(["whoami"]);
    expect(typeof json.identity?.id === "string", "identity.id");
    expect(typeof json.identity?.email === "string", "identity.email");
  });
}

async function phase1_org(): Promise<{ orgId: string }> {
  header("1", "org");

  await step("me org list", async () => {
    await runJson<{ orgs: unknown[] }>(["org", "list"]);
  });

  let orgId = "";
  await step(`me org create ${ORG_NAME}`, async () => {
    const { json } = await runJson<{ id: string; name: string; slug: string }>([
      "org",
      "create",
      ORG_NAME,
    ]);
    expect(typeof json.id === "string", "org.id");
    expectEq(json.name, ORG_NAME, "org.name");
    orgId = json.id;
  });

  await step("me org list (verify created)", async () => {
    const { json } = await runJson<{ orgs: { id: string; name: string }[] }>([
      "org",
      "list",
    ]);
    expect(
      json.orgs.some((o) => o.id === orgId),
      `org ${orgId} present in list`,
    );
  });

  await step("me org member list", async () => {
    if (!orgId) throw new Error("no orgId — prior step failed");
    const { json } = await runJson<{ members: unknown[] }>([
      "org",
      "member",
      "list",
      "--org",
      orgId,
    ]);
    expect(Array.isArray(json.members), "members is array");
    expect(json.members.length >= 1, "at least one member (the creator)");
  });

  return { orgId };
}

async function phase2_engine(orgId: string): Promise<{ engineId: string }> {
  header("2", "engine");

  await step("me engine list", async () => {
    await runJson<{ engines: unknown[] }>(["engine", "list"]);
  });

  let engineId = "";
  await step(`me engine create ${ENGINE_NAME}`, async () => {
    if (!orgId) throw new Error("no orgId");
    const { json } = await runJson<{
      id: string;
      name: string;
      slug: string;
      status: string;
    }>(["engine", "create", ENGINE_NAME, "--org", orgId]);
    expect(typeof json.id === "string", "engine.id");
    expectEq(json.name, ENGINE_NAME, "engine.name");
    engineId = json.id;
  });

  await step(`me engine use ${ENGINE_NAME}`, async () => {
    if (!engineId) throw new Error("no engineId");
    const { json } = await runJson<{
      engine: string;
      slug: string;
      org: string;
      setup?: boolean;
      switched?: boolean;
    }>(["engine", "use", engineId]);
    expectEq(json.engine, ENGINE_NAME, "engine name");
  });

  await step("me whoami (with engine)", async () => {
    const { json } = await runJson<{
      activeEngine: string | null;
      hasApiKey: boolean;
    }>(["whoami"]);
    expect(typeof json.activeEngine === "string", "active engine set");
    expectEq(json.hasApiKey, true, "has api key");
  });

  return { engineId };
}

async function phase3_invitation(orgId: string): Promise<void> {
  header("3", "invitation");

  let invitationId = "";
  await step("me invitation create", async () => {
    if (!orgId) throw new Error("no orgId");
    const { json } = await runJson<{
      id: string;
      email: string;
      role: string;
      token: string;
    }>([
      "invitation",
      "create",
      `itest-${RUN_ID}@example.invalid`,
      "member",
      "--org",
      orgId,
      "--expires",
      "1",
    ]);
    expect(typeof json.id === "string", "invitation.id");
    expect(typeof json.token === "string", "invitation.token");
    invitationId = json.id;
  });

  await step("me invitation list", async () => {
    if (!orgId) throw new Error("no orgId");
    const { json } = await runJson<{ invitations: { id: string }[] }>([
      "invitation",
      "list",
      "--org",
      orgId,
    ]);
    if (invitationId) {
      expect(
        json.invitations.some((i) => i.id === invitationId),
        `invitation ${invitationId} present`,
      );
    }
  });

  await step("me invitation revoke", async () => {
    if (!invitationId) throw new Error("no invitationId");
    await runJson<unknown>(["invitation", "revoke", invitationId]);
  });

  recordSkip("me invitation accept", "needs second identity");
}

async function phase4_rbac(): Promise<void> {
  header("4", "rbac");

  // ---- users ----
  await step("me user list", async () => {
    const { json } = await runJson<{ users: unknown[] }>(["user", "list"]);
    expect(Array.isArray(json.users), "users array");
  });

  await step("me user list --login-only", async () => {
    await runJson<{ users: unknown[] }>(["user", "list", "--login-only"]);
  });

  await step("me user create itest_user", async () => {
    const { json } = await runJson<{ id: string; name: string }>([
      "user",
      "create",
      "itest_user",
    ]);
    expectEq(json.name, "itest_user", "user name");
  });

  await step("me user get itest_user", async () => {
    const { json } = await runJson<{ name: string }>([
      "user",
      "get",
      "itest_user",
    ]);
    expectEq(json.name, "itest_user", "user name");
  });

  await step("me user rename itest_user → itest_user2", async () => {
    await runJson<{ renamed: boolean }>([
      "user",
      "rename",
      "itest_user",
      "itest_user2",
    ]);
  });

  // ---- roles ----
  await step("me role create itest_role", async () => {
    await runJson<{ id: string; name: string }>([
      "role",
      "create",
      "itest_role",
    ]);
  });

  await step("me role list", async () => {
    const { json } = await runJson<{ roles: { name: string }[] }>([
      "role",
      "list",
    ]);
    expect(
      json.roles.some((r) => r.name === "itest_role"),
      "itest_role present",
    );
  });

  await step("me role add-member itest_role itest_user2", async () => {
    await runJson<{ added: boolean }>([
      "role",
      "add-member",
      "itest_role",
      "itest_user2",
    ]);
  });

  await step("me role members itest_role", async () => {
    const { json } = await runJson<{ members: { memberName: string }[] }>([
      "role",
      "members",
      "itest_role",
    ]);
    expect(
      json.members.some((m) => m.memberName === "itest_user2"),
      "itest_user2 in role",
    );
  });

  await step("me role list-for itest_user2", async () => {
    const { json } = await runJson<{ roles: { name: string }[] }>([
      "role",
      "list-for",
      "itest_user2",
    ]);
    expect(
      json.roles.some((r) => r.name === "itest_role"),
      "itest_role in user's roles",
    );
  });

  await step("me role remove-member itest_role itest_user2", async () => {
    await runJson<{ removed: boolean }>([
      "role",
      "remove-member",
      "itest_role",
      "itest_user2",
    ]);
  });

  // ---- grants ----
  await step("me grant create itest_user2 ... read create update", async () => {
    await runJson<unknown>([
      "grant",
      "create",
      "itest_user2",
      TREE_BASE,
      "read",
      "create",
      "update",
      "--with-grant-option",
    ]);
  });

  await step("me grant list", async () => {
    const { json } = await runJson<{ grants: unknown[] }>(["grant", "list"]);
    expect(Array.isArray(json.grants), "grants array");
  });

  await step("me grant list itest_user2", async () => {
    const { json } = await runJson<{ grants: { treePath: string }[] }>([
      "grant",
      "list",
      "itest_user2",
    ]);
    expect(json.grants.length >= 1, "at least one grant for itest_user2");
  });

  await step("me grant check itest_user2 ... read", async () => {
    const { json } = await runJson<{ allowed: boolean }>([
      "grant",
      "check",
      "itest_user2",
      TREE_BASE,
      "read",
    ]);
    expectEq(json.allowed, true, "read allowed");
  });

  await step("me grant revoke itest_user2 ...", async () => {
    await runJson<unknown>(["grant", "revoke", "itest_user2", TREE_BASE]);
  });

  // ---- owners ----
  await step("me owner set TREE_BASE itest_user2", async () => {
    await runJson<unknown>(["owner", "set", TREE_BASE, "itest_user2"]);
  });

  await step("me owner get TREE_BASE", async () => {
    await runJson<unknown>(["owner", "get", TREE_BASE]);
  });

  await step("me owner list", async () => {
    await runJson<unknown>(["owner", "list"]);
  });

  await step("me owner list itest_user2", async () => {
    await runJson<unknown>(["owner", "list", "itest_user2"]);
  });

  await step("me owner remove TREE_BASE", async () => {
    await runJson<unknown>(["owner", "remove", TREE_BASE]);
  });

  // ---- apikeys ----
  let apiKeyId = "";
  await step("me apikey create itest_user2", async () => {
    const { json } = await runJson<{
      apiKey: { id: string; name: string };
      rawKey: string;
    }>(["apikey", "create", "itest_user2", "itest-key"]);
    expect(typeof json.apiKey?.id === "string", "apikey.id");
    expect(typeof json.rawKey === "string", "rawKey");
    apiKeyId = json.apiKey.id;
  });

  await step("me apikey list itest_user2", async () => {
    const { json } = await runJson<{ apiKeys: { id: string }[] }>([
      "apikey",
      "list",
      "itest_user2",
    ]);
    if (apiKeyId) {
      expect(
        json.apiKeys.some((k) => k.id === apiKeyId),
        `apikey ${apiKeyId} present`,
      );
    }
  });

  await step("me apikey revoke", async () => {
    if (!apiKeyId) throw new Error("no apiKeyId");
    await runJson<{ revoked: boolean }>(["apikey", "revoke", apiKeyId]);
  });

  await step("me apikey delete --yes", async () => {
    if (!apiKeyId) throw new Error("no apiKeyId");
    await runJson<{ deleted: boolean }>([
      "apikey",
      "delete",
      apiKeyId,
      "--yes",
    ]);
  });
}

async function phase5_memory(): Promise<void> {
  header("5", "memory");

  // ---- create (3 paths: positional, --content, stdin) ----
  let id1 = "";
  let id2 = "";
  let id3 = "";

  await step("me memory create (positional)", async () => {
    const { json } = await runJson<{ id: string; tree: string }>([
      "memory",
      "create",
      `first ${RUN_ID}`,
      "--tree",
      `${TREE_BASE}.basic`,
      "--meta",
      JSON.stringify({ itest: true, run_id: RUN_ID, kind: "positional" }),
    ]);
    expect(typeof json.id === "string", "memory.id");
    id1 = json.id;
  });

  await step("me memory create (--content + --temporal + --meta)", async () => {
    const { json } = await runJson<{ id: string }>([
      "memory",
      "create",
      "--content",
      `second flag-content ${RUN_ID}`,
      "--tree",
      `${TREE_BASE}.basic`,
      "--meta",
      JSON.stringify({ itest: true, run_id: RUN_ID, kind: "flag" }),
      "--temporal",
      "2026-01-01T00:00:00Z,2026-12-31T00:00:00Z",
    ]);
    id2 = json.id;
  });

  await step("me memory create (stdin)", async () => {
    const { json } = await runJson<{ id: string }>(
      [
        "memory",
        "create",
        "--tree",
        `${TREE_BASE}.basic`,
        "--meta",
        JSON.stringify({ itest: true, run_id: RUN_ID, kind: "stdin" }),
      ],
      { stdin: `via stdin ${RUN_ID}\n` },
    );
    id3 = json.id;
  });

  // ---- get (json + raw) ----
  await step("me memory get (json)", async () => {
    if (!id1) throw new Error("no id1");
    const { json } = await runJson<{ id: string; content: string }>([
      "memory",
      "get",
      id1,
    ]);
    expectEq(json.id, id1, "memory.id");
  });

  await step("me memory get --raw", async () => {
    if (!id1) throw new Error("no id1");
    const r = await run(["memory", "get", id1, "--raw"]);
    expectEq(r.exit, 0, "exit");
    expect(r.stdout.startsWith("---"), "raw output starts with frontmatter");
  });

  // ---- search ----
  await step("me memory search (hybrid)", async () => {
    const { json } = await runJson<{ total: number; results: unknown[] }>([
      "memory",
      "search",
      `first ${RUN_ID}`,
      "--limit",
      "5",
      "--tree",
      `${TREE_BASE}.*`,
    ]);
    expect(json.results.length >= 1, "at least one hybrid match");
  });

  await step("me memory search --semantic", async () => {
    await runJson<{ results: unknown[] }>([
      "memory",
      "search",
      "--semantic",
      "thing about flags",
      "--tree",
      `${TREE_BASE}.*`,
      "--limit",
      "5",
    ]);
  });

  await step("me memory search --fulltext", async () => {
    const { json } = await runJson<{ results: { id: string }[] }>([
      "memory",
      "search",
      "--fulltext",
      RUN_ID,
      "--tree",
      `${TREE_BASE}.*`,
      "--limit",
      "10",
    ]);
    expect(json.results.length >= 1, "fulltext should match RUN_ID token");
  });

  await step("me memory search --grep", async () => {
    await runJson<{ results: unknown[] }>([
      "memory",
      "search",
      "--grep",
      "fir",
      "--tree",
      `${TREE_BASE}.*`,
    ]);
  });

  await step("me memory search --meta", async () => {
    const { json } = await runJson<{ results: { id: string }[] }>([
      "memory",
      "search",
      "--meta",
      JSON.stringify({ kind: "flag", run_id: RUN_ID }),
      "--limit",
      "10",
    ]);
    expect(
      json.results.some((r) => r.id === id2),
      `meta filter should find id2 (${id2})`,
    );
  });

  await step("me memory search --temporal-overlaps", async () => {
    const { json } = await runJson<{ results: { id: string }[] }>([
      "memory",
      "search",
      "--temporal-overlaps",
      "2026-06-01T00:00:00Z,2026-06-30T00:00:00Z",
      "--tree",
      `${TREE_BASE}.*`,
      "--limit",
      "10",
    ]);
    expect(
      json.results.some((r) => r.id === id2),
      `temporal-overlaps should find id2 (${id2})`,
    );
  });

  await step("me memory search --temporal-within", async () => {
    await runJson<{ results: unknown[] }>([
      "memory",
      "search",
      "--temporal-within",
      "2025-12-31T00:00:00Z,2027-01-01T00:00:00Z",
      "--tree",
      `${TREE_BASE}.*`,
    ]);
  });

  await step("me memory search --temporal-contains", async () => {
    await runJson<{ results: unknown[] }>([
      "memory",
      "search",
      "--temporal-contains",
      "2026-06-15T00:00:00Z",
      "--tree",
      `${TREE_BASE}.*`,
    ]);
  });

  await step("me memory search (weights + order-by)", async () => {
    await runJson<{ results: unknown[] }>([
      "memory",
      "search",
      `first ${RUN_ID}`,
      "--weight-semantic",
      "0.7",
      "--weight-fulltext",
      "0.3",
      "--order-by",
      "desc",
      "--tree",
      `${TREE_BASE}.*`,
    ]);
  });

  // ---- update ----
  await step("me memory update", async () => {
    if (!id1) throw new Error("no id1");
    await runJson<{ id: string }>([
      "memory",
      "update",
      id1,
      "--content",
      `first-updated ${RUN_ID}`,
      "--meta",
      JSON.stringify({
        itest: true,
        run_id: RUN_ID,
        kind: "positional",
        updated: true,
      }),
    ]);
  });

  // ---- tree ----
  await step("me memory tree", async () => {
    const { json } = await runJson<{ nodes: unknown[] }>([
      "memory",
      "tree",
      TREE_BASE,
      "--levels",
      "3",
    ]);
    expect(Array.isArray(json.nodes), "tree.nodes is array");
  });

  // ---- move (dry-run + real) ----
  await step("me memory move --dry-run", async () => {
    const { json } = await runJson<{ count: number; dryRun?: boolean }>([
      "memory",
      "move",
      `${TREE_BASE}.basic`,
      `${TREE_BASE}.moved`,
      "--dry-run",
    ]);
    expect(json.count >= 3, "at least the 3 created memories under basic");
  });

  await step("me memory move --yes (real)", async () => {
    const { json } = await runJson<{ count: number }>([
      "memory",
      "move",
      `${TREE_BASE}.basic`,
      `${TREE_BASE}.moved`,
      "--yes",
    ]);
    expect(json.count >= 3, "moved >= 3 memories");
  });

  await step("me memory move (back) --yes", async () => {
    await runJson<{ count: number }>([
      "memory",
      "move",
      `${TREE_BASE}.moved`,
      `${TREE_BASE}.basic`,
      "--yes",
    ]);
  });

  // ---- delete (single uuid path) ----
  await step("me memory delete <uuid>", async () => {
    if (!id3) throw new Error("no id3");
    const { json } = await runJson<{ deleted: boolean }>([
      "memory",
      "delete",
      id3,
    ]);
    expectEq(json.deleted, true, "deleted");
  });

  // ---- import (md, yaml, json, ndjson) ----
  await step("me memory import (4 fixture files)", async () => {
    const { json } = await runJson<{ imported: number; failed: number }>([
      "memory",
      "import",
      join(fixturesDir, "sample.md"),
      join(fixturesDir, "sample.yaml"),
      join(fixturesDir, "sample.json"),
      join(fixturesDir, "sample.ndjson"),
      "-v",
    ]);
    // md=1, yaml=2, json=1, ndjson=3 → 7
    expectEq(json.imported, 7, "imported count");
    expectEq(json.failed, 0, "failed count");
  });

  await step("me memory import (recursive --dry-run)", async () => {
    // exclude the pack yaml from the picture by importing only the
    // sample files via the directory recursion.
    const dryDir = join(tempRoot, "dryrun-fixtures");
    mkdirSync(dryDir, { recursive: true });
    for (const f of [
      "sample.md",
      "sample.yaml",
      "sample.json",
      "sample.ndjson",
    ]) {
      writeFileSync(
        join(dryDir, f),
        readFileSync(join(fixturesDir, f), "utf-8"),
      );
    }
    const { json } = await runJson<{ wouldImport: number; dryRun: boolean }>([
      "memory",
      "import",
      dryDir,
      "-r",
      "--dry-run",
    ]);
    expectEq(json.dryRun, true, "dryRun");
    expectEq(json.wouldImport, 7, "wouldImport");
  });

  // ---- export (json stdout, yaml file, md dir) ----
  await step("me memory export (json stdout)", async () => {
    const { json } = await runJson<unknown[]>([
      "memory",
      "export",
      "--tree",
      `${TREE_BASE}.*`,
      "--format",
      "json",
      "--limit",
      "1000",
    ]);
    expect(Array.isArray(json), "export json is array");
    expect(json.length >= 1, "export non-empty");
  });

  await step("me memory export (yaml → file)", async () => {
    const out = join(tempRoot, "export.yaml");
    const { json } = await runJson<{ count: number; file: string }>([
      "memory",
      "export",
      out,
      "--tree",
      `${TREE_BASE}.*`,
      "--format",
      "yaml",
    ]);
    expect(json.count >= 1, "exported >=1");
    expect(existsSync(out), "yaml file exists");
  });

  await step("me memory export (md → directory)", async () => {
    const outDir = join(tempRoot, "export-md");
    const { json } = await runJson<{ count: number; directory: string }>([
      "memory",
      "export",
      outDir,
      "--tree",
      `${TREE_BASE}.*`,
      "--format",
      "md",
    ]);
    expect(json.count >= 1, "md export count");
    expect(existsSync(outDir), "md directory exists");
  });

  recordSkip("me memory edit", "spawns $EDITOR");
}

async function phase6_pack(): Promise<void> {
  header("6", "pack");

  const packPath = join(fixturesDir, "itest-pack.yaml");

  await step("me pack validate", async () => {
    const { json } = await runJson<{ valid: boolean; memories: number }>([
      "pack",
      "validate",
      packPath,
    ]);
    expectEq(json.valid, true, "pack valid");
    expectEq(json.memories, 3, "pack memory count");
  });

  await step("me pack install --dry-run", async () => {
    const { json } = await runJson<{ wouldInstall: number; dryRun: boolean }>([
      "pack",
      "install",
      packPath,
      "--dry-run",
    ]);
    expectEq(json.dryRun, true, "dryRun");
    expectEq(json.wouldInstall, 3, "wouldInstall");
  });

  await step("me pack install --yes", async () => {
    const { json } = await runJson<{ installed: number; staleRemoved: number }>(
      ["pack", "install", packPath, "--yes"],
    );
    expectEq(json.installed, 3, "installed");
    expectEq(json.staleRemoved, 0, "no stale on first install");
  });

  await step("me pack list (after install)", async () => {
    const { json } = await runJson<{
      packs: { name: string; version: string; count: number }[];
    }>(["pack", "list"]);
    const found = json.packs.find((p) => p.name === "me_itest_pack");
    expect(found !== undefined, "me_itest_pack present");
    expectEq(found?.version, "0.1.0", "pack version");
  });

  await step(
    "me pack install --yes (bumped → exercise stale removal)",
    async () => {
      const bumped = makeBumpedPack();
      const { json } = await runJson<{
        installed: number;
        staleRemoved: number;
      }>(["pack", "install", bumped, "--yes"]);
      expectEq(json.installed, 3, "installed");
      expect(json.staleRemoved >= 1, "staleRemoved >= 1 on version bump");
    },
  );
}

async function phase7_teardown(): Promise<void> {
  header("7", "teardown");

  // Tree-mode delete (this is the one phase that exercises the tree branch).
  await step(`me memory delete ${TREE_BASE} --yes (tree mode)`, async () => {
    await runJson<{ count: number }>(["memory", "delete", TREE_BASE, "--yes"]);
  });

  await step(`me memory delete ${PACK_TREE} --yes`, async () => {
    await runJson<{ count: number }>(["memory", "delete", PACK_TREE, "--yes"]);
  });

  // role/user cleanup — best-effort.
  await step("me role delete itest_role --yes", async () => {
    await runJson<unknown>(["role", "delete", "itest_role", "--yes"]);
  });

  await step("me user delete itest_user2 --yes", async () => {
    await runJson<unknown>(["user", "delete", "itest_user2", "--yes"]);
  });

  // Engine — `delete` skips confirmation in --json mode.
  await step(`me engine delete ${ENGINE_NAME}`, async () => {
    await runJson<{ deleted: boolean }>(["engine", "delete", ENGINE_NAME]);
  });

  await step(`me org delete ${ORG_NAME} --yes`, async () => {
    await runJson<{ deleted: boolean }>(["org", "delete", ORG_NAME, "--yes"]);
  });

  await step("me logout", async () => {
    const r = await run(["logout"]);
    expectEq(r.exit, 0, "logout exit");
  });

  // Remove the temp config dir.
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// =============================================================================
// Report
// =============================================================================

function renderReport(totalMs: number): number {
  const phases = new Map<
    string,
    { pass: number; fail: number; skip: number; total: number }
  >();
  for (const r of records) {
    const p = phases.get(r.phase) ?? { pass: 0, fail: 0, skip: 0, total: 0 };
    p[r.status]++;
    p.total++;
    phases.set(r.phase, p);
  }

  const totals = { pass: 0, fail: 0, skip: 0, total: 0 };
  for (const p of phases.values()) {
    totals.pass += p.pass;
    totals.fail += p.fail;
    totals.skip += p.skip;
    totals.total += p.total;
  }

  const phaseLabels: Record<string, string> = {
    "0": "bootstrap",
    "1": "org",
    "2": "engine",
    "3": "invitation",
    "4": "rbac",
    "5": "memory",
    "6": "pack",
    "7": "teardown",
  };

  console.log();
  console.log("\x1b[1m═════ me CLI integration test report ═════\x1b[0m");
  console.log(`Run ID:   ${RUN_ID}`);
  console.log(`Server:   ${baseEnv.ME_SERVER}`);
  console.log(`Binary:   ${binary}`);
  console.log(`Duration: ${(totalMs / 1000).toFixed(1)}s`);
  console.log();
  console.log("Phase                  pass  fail  skip  total");
  console.log("───────────────────────────────────────────────");
  const phaseKeys = Array.from(phases.keys()).sort();
  for (const k of phaseKeys) {
    const p = phases.get(k);
    if (!p) continue;
    const label = `${k} ${phaseLabels[k] ?? ""}`;
    console.log(
      `${label.padEnd(22)} ${String(p.pass).padStart(4)}  ${String(p.fail).padStart(4)}  ${String(
        p.skip,
      ).padStart(4)}  ${String(p.total).padStart(5)}`,
    );
  }
  console.log("───────────────────────────────────────────────");
  console.log(
    `${"TOTAL".padEnd(22)} ${String(totals.pass).padStart(4)}  ${String(
      totals.fail,
    ).padStart(
      4,
    )}  ${String(totals.skip).padStart(4)}  ${String(totals.total).padStart(5)}`,
  );

  // Failure details.
  const failures = records.filter((r) => r.status === "fail");
  if (failures.length > 0) {
    console.log();
    console.log("\x1b[31mFailures:\x1b[0m");
    for (const f of failures) {
      console.log(`  ✗ [${f.phase}] ${f.command}`);
      if (f.exit !== undefined) console.log(`      exit ${f.exit}`);
      if (f.message) console.log(`      ${f.message.split("\n")[0]}`);
      if (f.stderrTail) {
        for (const line of f.stderrTail.split("\n").slice(-6)) {
          console.log(`      | ${line}`);
        }
      }
    }
  }

  console.log();
  if (totals.fail === 0) {
    console.log("\x1b[32mResult: PASS\x1b[0m");
    return 0;
  }
  console.log(`\x1b[31mResult: FAIL (${totals.fail} failed)\x1b[0m`);
  return 1;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = parseArgs();
  binary = resolveBinary(args.bin);

  // Set up isolated XDG_CONFIG_HOME.
  tempRoot = mkdtempSync(join(tmpdir(), "me-itest-"));
  configDir = join(tempRoot, "config");
  mkdirSync(configDir, { recursive: true });

  const server =
    args.server ??
    process.env.ME_SERVER ??
    "https://me.dev-us-east-1.ops.dev.timescale.com";

  // Build the child env from a copy of process.env, then strip any creds
  // vars that might leak from the user's shell. We rely on the credentials
  // file alone (under our isolated XDG_CONFIG_HOME). Note: setting these
  // to "" instead of deleting would be wrong — the CLI uses
  // `process.env.ME_SESSION_TOKEN ?? stored`, and `??` does not coalesce
  // empty strings, so an empty value would override the stored token.
  baseEnv = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: configDir,
    ME_SERVER: server,
  };
  delete baseEnv.ME_API_KEY;
  delete baseEnv.ME_SESSION_TOKEN;

  fixturesDir = prepareFixtures();

  console.log("\x1b[1m═════ me CLI integration test ═════\x1b[0m");
  console.log(`Run ID:    ${RUN_ID}`);
  console.log(`Server:    ${server}`);
  console.log(`Binary:    ${binary}`);
  console.log(`Temp root: ${tempRoot}`);
  console.log(`Org:       ${ORG_NAME}`);
  console.log(`Engine:    ${ENGINE_NAME}`);
  console.log(`Tree base: ${TREE_BASE}`);

  const overallStart = performance.now();

  let createdOrgId = "";
  let createdEngine = false;

  try {
    await phase0_bootstrap();

    const { orgId } = await phase1_org();
    createdOrgId = orgId;

    if (createdOrgId) {
      await phase2_engine(createdOrgId);
      createdEngine = true;

      await phase3_invitation(createdOrgId);
      await phase4_rbac();
      await phase5_memory();
      await phase6_pack();
    } else {
      console.log("\x1b[33mSkipping phases 2-6 — no org created.\x1b[0m");
    }
  } catch (e) {
    console.error(
      "\x1b[31mUnhandled error during run:\x1b[0m",
      (e as Error).message,
    );
  } finally {
    // Best-effort teardown — only attempt the bits we got far enough to
    // create. If org creation failed we have nothing to delete.
    if (createdOrgId || createdEngine) {
      await phase7_teardown();
    } else {
      console.log("\nNo server-side state to tear down.");
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    }
  }

  const totalMs = Math.round(performance.now() - overallStart);
  const code = renderReport(totalMs);
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
