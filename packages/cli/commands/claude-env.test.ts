/**
 * Black-box tests for `me claude env` (the SessionStart hook handler) —
 * spawns the real CLI since the command's own logic is a thin wire-up of
 * already-unit-tested pieces (isInjectionLive/buildContractVars/
 * upsertContractBlock, see harness-contract.test.ts); what's worth verifying
 * here is the process-level wiring: stdin payload → env file, the
 * first-writer-wins gate, and fail-open behavior.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ME_INJECT_VERSION } from "../harness-contract.ts";

const CLI_ENTRY = join(import.meta.dir, "..", "index.ts");

/** Parse `env`'s NAME=value output lines into a map. */
function parseEnvOutput(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    map[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return map;
}

async function runClaudeEnv(
  payload: unknown,
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, "claude", "env"], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

describe("me claude env", () => {
  test("writes the contract block anchored to the session's cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-claude-env-"));
    const envFile = join(dir, "claude-env.sh");
    try {
      const { exitCode } = await runClaudeEnv(
        { cwd: "/some/project" },
        { CLAUDE_ENV_FILE: envFile, ME_INJECT_V: undefined },
      );
      expect(exitCode).toBe(0);
      const content = readFileSync(envFile, "utf-8");
      expect(content).toContain('export AI_AGENT="claude"');
      expect(content).toContain('export ME_AS_AGENT=".me"');
      expect(content).toContain('export ME_PROJECT_DIR="/some/project"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the written contract, when sourced by a real shell, actually sets the env vars", async () => {
    // Claude Code's own half of the contract is sourcing $CLAUDE_ENV_FILE
    // before every Bash tool command — we don't control or test that part
    // (it's Claude Code's own documented behavior), but we DO control
    // whether the file we write is valid, sourceable shell that correctly
    // sets these vars. Prove it by actually sourcing it in a real shell and
    // reading back a real process's environment, not just the file's text.
    const dir = mkdtempSync(join(tmpdir(), "me-claude-env-"));
    const envFile = join(dir, "claude-env.sh");
    try {
      const { exitCode } = await runClaudeEnv(
        { cwd: "/some/project" },
        { CLAUDE_ENV_FILE: envFile, ME_INJECT_V: undefined },
      );
      expect(exitCode).toBe(0);

      const proc = Bun.spawn(["bash", "-c", `source "${envFile}" && env`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);

      const env = parseEnvOutput(stdout);
      expect(env.ME_INJECT_V).toBe(ME_INJECT_VERSION);
      expect(env.AI_AGENT).toBe("claude");
      expect(env.ME_AS_AGENT).toBe(".me");
      expect(env.ME_PROJECT_DIR).toBe("/some/project");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("first-writer-wins: emits nothing when the contract is already live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-claude-env-"));
    const envFile = join(dir, "claude-env.sh");
    writeFileSync(envFile, "export SOME_VAR=1\n");
    try {
      const { exitCode } = await runClaudeEnv(
        { cwd: "/some/project" },
        {
          CLAUDE_ENV_FILE: envFile,
          ME_INJECT_V: "1",
          ME_AS_AGENT: ".me",
          ME_PROJECT_DIR: "/other/project",
        },
      );
      expect(exitCode).toBe(0);
      expect(readFileSync(envFile, "utf-8")).toBe("export SOME_VAR=1\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a PARTIALLY live contract (ME_INJECT_V alone) does NOT trigger first-writer-wins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-claude-env-"));
    const envFile = join(dir, "claude-env.sh");
    try {
      const { exitCode } = await runClaudeEnv(
        { cwd: "/some/project" },
        {
          CLAUDE_ENV_FILE: envFile,
          ME_INJECT_V: "1",
          ME_AS_AGENT: undefined,
          ME_PROJECT_DIR: undefined,
        },
      );
      expect(exitCode).toBe(0);
      expect(readFileSync(envFile, "utf-8")).toContain(
        'export ME_PROJECT_DIR="/some/project"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails open (exit 0) when CLAUDE_ENV_FILE is unset", async () => {
    const { exitCode } = await runClaudeEnv(
      { cwd: "/some/project" },
      { CLAUDE_ENV_FILE: undefined, ME_INJECT_V: undefined },
    );
    expect(exitCode).toBe(0);
  });

  test("fails open (exit 0) when the write itself fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-claude-env-"));
    try {
      // Point CLAUDE_ENV_FILE inside what is actually a FILE, not a
      // directory — mkdirSync(dirname(...), { recursive: true }) then
      // throws ENOTDIR, exercising upsertContractBlock's write failure.
      const blockerFile = join(dir, "not-a-directory");
      writeFileSync(blockerFile, "x");
      const envFile = join(blockerFile, "claude-env.sh");
      const { exitCode, stderr } = await runClaudeEnv(
        { cwd: "/some/project" },
        { CLAUDE_ENV_FILE: envFile, ME_INJECT_V: undefined },
      );
      expect(exitCode).toBe(0);
      expect(stderr).toContain("failed to write the harness contract");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails open (exit 0, no write) on a malformed stdin payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-claude-env-"));
    const envFile = join(dir, "claude-env.sh");
    try {
      const proc = Bun.spawn([process.execPath, CLI_ENTRY, "claude", "env"], {
        env: {
          ...process.env,
          CLAUDE_ENV_FILE: envFile,
          ME_INJECT_V: undefined,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write("not json");
      proc.stdin.end();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(() => readFileSync(envFile, "utf-8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
