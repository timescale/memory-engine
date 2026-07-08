/**
 * Black-box test for `me codex env-hook`'s process wiring (stdin → stdout,
 * fail-open exit code, shape logging). The rewrite decision logic itself is
 * covered by codex/env-hook.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "index.ts");

async function runCodexEnvHook(
  stdin: string,
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, "codex", "env-hook"], {
    env: { ...process.env, ME_INJECT_V: undefined, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("me codex env-hook", () => {
  test("prints the rewrite JSON for a Bash tool call", async () => {
    const { exitCode, stdout } = await runCodexEnvHook(
      JSON.stringify({
        cwd: "/repo/project",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.updatedInput.command).toContain(
      "npm test",
    );
    expect(parsed.hookSpecificOutput.updatedInput.command).toContain(
      'ME_PROJECT_DIR="/repo/project"',
    );
  });

  test("prints nothing for a non-Bash tool call", async () => {
    const { exitCode, stdout } = await runCodexEnvHook(
      JSON.stringify({
        cwd: "/repo",
        tool_name: "apply_patch",
        tool_input: {},
      }),
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("fails open on malformed JSON and logs the shape", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "me-codex-hook-"));
    try {
      const { exitCode, stdout } = await runCodexEnvHook("not json at all", {
        XDG_CONFIG_HOME: configDir,
      });
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
      const log = readFileSync(
        join(configDir, "me", "state", "harness-payload-shapes.ndjson"),
        "utf-8",
      );
      expect(log).toContain('"harness":"codex"');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("first-writer-wins: prints nothing when ME_INJECT_V is already live", async () => {
    const { exitCode, stdout } = await runCodexEnvHook(
      JSON.stringify({
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      }),
      { ME_INJECT_V: "1" },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
