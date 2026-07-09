/**
 * ONE-OFF, MANUAL smoke test: does a real Gemini CLI `BeforeTool` hook
 * actually rewrite a shell command with the harness contract, and does the
 * rewritten command really export working env vars when Gemini runs it?
 *
 * BEST-EFFORT / UNVERIFIED — the `gemini` binary is not installed on the
 * machine this was authored on, so the invocation below (`gemini -p
 * "<prompt>" --approval-mode yolo`) is built from Gemini CLI's public docs,
 * not a live run. See CLAUDE.md's "Harness smoke tests" section if this
 * fails on a first real run — `--approval-mode` is the flag most likely to
 * have moved.
 *
 * Mechanism: writes the hook entry into a scratch project's
 * `.gemini/settings.json` (project scope — Gemini CLI loads and overrides
 * user settings with it, so the developer's real `~/.gemini/settings.json`
 * and its login are never touched), then runs `gemini -p` there and asks it
 * to reveal the vars its own BeforeTool hook should have rewritten in.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const GEMINI_BIN = Bun.which("gemini");

test.skipIf(!smokeTestsEnabled() || !GEMINI_BIN)(
  "real Gemini CLI: BeforeTool hook injects working env vars into a shell call",
  async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "me-gemini-smoke-"));
    const meBinDir = writeMeWrapper();
    try {
      const geminiDir = join(projectDir, ".gemini");
      mkdirSync(geminiDir, { recursive: true });
      writeFileSync(
        join(geminiDir, "settings.json"),
        `${JSON.stringify(
          {
            hooks: {
              BeforeTool: [
                {
                  matcher: "run_shell_command",
                  hooks: [{ type: "command", command: "me gemini env-hook" }],
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
      );

      const proc = Bun.spawn(
        [
          GEMINI_BIN as string,
          "-p",
          markerPrompt(REVEAL_COMMAND),
          "--approval-mode",
          "yolo",
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
      ).toBe("gemini-cli");
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
