/**
 * ONE-OFF, MANUAL smoke test: does a real OpenCode run actually load our
 * generated capture plugin's `shell.env` hook and inject the four contract
 * vars into a real shell-tool call's environment?
 *
 * Verified live against opencode 1.17.16 (`opencode run --auto`, project-
 * scoped `.opencode/plugins/`) — the `shell.env` hook fires and injects all
 * four vars correctly. Note there is no `--quiet`/`-q` flag on `run` in this
 * version (unlike some older CLI docs) — passing one makes yargs print
 * usage and exit 1, so don't add it back without checking `opencode run
 * --help` first.
 *
 * Mechanism: writes the real plugin source (`renderPluginSource()`, the
 * exact file `me opencode install`/`init` would write) into a scratch
 * project's `.opencode/plugins/` — project scope, so nothing under the
 * developer's real `~/.config/opencode/` is touched — then runs
 * `opencode run --auto` there and asks it to reveal the vars its own
 * shell.env hook should have merged in.
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPluginSource } from "../opencode/plugin-template.ts";
import { openCodePluginsDir } from "../opencode/scope.ts";
import {
  envForCwd,
  extractContractVars,
  markerPrompt,
  mkScratchDir,
  REVEAL_COMMAND,
  smokeTestsEnabled,
} from "./_shared.ts";

const OPENCODE_BIN = Bun.which("opencode");

test.skipIf(!smokeTestsEnabled() || !OPENCODE_BIN)(
  "real OpenCode run: the generated plugin's shell.env hook injects working env vars into a shell call",
  async () => {
    const projectDir = mkScratchDir("me-opencode-smoke-");
    try {
      const pluginsDir = openCodePluginsDir("project", projectDir);
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(join(pluginsDir, "memory-engine.ts"), renderPluginSource());

      const proc = Bun.spawn(
        [OPENCODE_BIN as string, "run", "--auto", markerPrompt(REVEAL_COMMAND)],
        {
          cwd: projectDir,
          env: envForCwd(projectDir),
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
