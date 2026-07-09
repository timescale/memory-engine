/**
 * ONE-OFF, MANUAL smoke test: does a real OpenCode run actually load our
 * generated capture plugin's `shell.env` hook and inject the four contract
 * vars into a real shell-tool call's environment?
 *
 * BEST-EFFORT / UNVERIFIED — the `opencode` binary is not installed on the
 * machine this was authored on, so the invocation below is built from
 * OpenCode's public CLI docs (`opencode run [message..] --auto`, project-
 * scoped `.opencode/plugins/`), not a live run. If this fails when you first
 * run it with `opencode` actually installed, the flags are the first thing
 * to check — see CLAUDE.md's "Harness smoke tests" section.
 *
 * Mechanism: writes the real plugin source (`renderPluginSource()`, the
 * exact file `me opencode install`/`init` would write) into a scratch
 * project's `.opencode/plugins/` — project scope, so nothing under the
 * developer's real `~/.config/opencode/` is touched — then runs
 * `opencode run --auto` there and asks it to reveal the vars its own
 * shell.env hook should have merged in.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPluginSource } from "../opencode/plugin-template.ts";
import { openCodePluginsDir } from "../opencode/scope.ts";
import {
  cleanEnv,
  extractContractVars,
  markerPrompt,
  REVEAL_COMMAND,
  smokeTestsEnabled,
} from "./_shared.ts";

const OPENCODE_BIN = Bun.which("opencode");

test.skipIf(!smokeTestsEnabled() || !OPENCODE_BIN)(
  "real OpenCode run: the generated plugin's shell.env hook injects working env vars into a shell call",
  async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "me-opencode-smoke-"));
    try {
      const pluginsDir = openCodePluginsDir("project", projectDir);
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(join(pluginsDir, "memory-engine.ts"), renderPluginSource());

      const proc = Bun.spawn(
        [
          OPENCODE_BIN as string,
          "run",
          "--auto",
          "--quiet",
          markerPrompt(REVEAL_COMMAND),
        ],
        {
          cwd: projectDir,
          env: cleanEnv(),
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
      ).toBe("opencode");
      expect(vars.ME_AS_AGENT).toBe(".me");
      expect(vars.ME_PROJECT_DIR).toBe(projectDir);
      expect(vars.ME_INJECT_V).toBeTruthy();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
  120_000,
);
