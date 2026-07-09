/**
 * ONE-OFF, MANUAL smoke test: does a real Claude Code session actually
 * source `$CLAUDE_ENV_FILE` before a Bash tool call, with our four contract
 * vars visible in that command's real environment?
 *
 * Not part of `check`/`check:full`/CI — see _shared.ts's module doc and
 * CLAUDE.md's "Harness smoke tests" section for how/why to run this.
 *
 * Mechanism: passes a SessionStart hook inline via `--settings` (a JSON
 * string, not a file on disk) so Claude Code doesn't need any on-disk
 * project/user config and never shows a trust dialog for it — the hook
 * points at a `me` wrapper (see writeMeWrapper()) that execs THIS
 * checkout's `packages/cli/index.ts`, so this proves out the current
 * working tree's `me claude env`, not whatever `me` happens to be globally
 * installed. `--setting-sources project,local` (omitting `user`) keeps the
 * run isolated from any real marketplace-plugin install on this machine.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanEnv,
  extractContractVars,
  markerPrompt,
  REVEAL_COMMAND,
  smokeTestsEnabled,
  writeMeWrapper,
} from "./_shared.ts";

const CLAUDE_BIN = Bun.which("claude");

test.skipIf(!smokeTestsEnabled() || !CLAUDE_BIN)(
  "real Claude Code session: SessionStart hook injects working env vars into a Bash call",
  async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "me-claude-smoke-"));
    const meBinDir = writeMeWrapper();
    try {
      const hookSettings = JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "me claude env" }],
            },
          ],
        },
      });

      const proc = Bun.spawn(
        [
          CLAUDE_BIN as string,
          "--print",
          "--permission-mode",
          "bypassPermissions",
          "--allowed-tools",
          "Bash",
          "--setting-sources",
          "project,local",
          "--settings",
          hookSettings,
          markerPrompt(REVEAL_COMMAND),
        ],
        {
          cwd: projectDir,
          env: { ...cleanEnv(), PATH: `${meBinDir}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      const vars = extractContractVars(stdout);
      expect(
        vars.AI_AGENT,
        `stdout was:\n${stdout}\nstderr was:\n${stderr}`,
      ).toBe("claude");
      expect(vars.ME_AS_AGENT).toBe(".me");
      expect(vars.ME_PROJECT_DIR).toBe(projectDir);
      expect(vars.ME_INJECT_V).toBeTruthy();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(meBinDir, { recursive: true, force: true });
    }
  },
  120_000,
);
