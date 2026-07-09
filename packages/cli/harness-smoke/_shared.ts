/**
 * Shared helpers for the harness smoke tests (packages/cli/harness-smoke/).
 *
 * These are ONE-OFF, MANUAL tests — they launch the real harness binary
 * (claude/opencode/codex/gemini) non-interactively, which makes a real model
 * call under whatever account is authenticated on this machine and costs
 * real API tokens. They are deliberately NOT named `*.test.ts`, so `bun test
 * packages`, `test:unit`, and `test:db` never pick them up — see CLAUDE.md
 * for how to run them. Every file also checks {@link smokeTestsEnabled} so
 * even an explicit `bun test packages/cli/harness-smoke/<file>.smoke.ts`
 * skips (rather than spends money) unless you opt in with
 * `ME_HARNESS_SMOKE=1`.
 *
 * The mechanism under test is narrow and deliberately free of any memory-
 * engine credentials: `me claude env` / the opencode `shell.env` hook / the
 * Codex and Gemini env-hooks only read their stdin/tool-call payload and
 * write or rewrite an env contract — no network call, no `.me/config.yaml`,
 * no login. So these smoke tests only need the HARNESS itself authenticated
 * (an existing `claude`/`codex`/`gemini`/`opencode` login), never a
 * memory-engine account.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set ME_HARNESS_SMOKE=1 to actually run these (they cost real API tokens). */
export function smokeTestsEnabled(): boolean {
  return process.env.ME_HARNESS_SMOKE === "1";
}

/** Path to this checkout's own `packages/cli/index.ts`, so the smoke tests
 * exercise the CURRENT working tree, not whatever `me` happens to be
 * globally installed. */
const CLI_ENTRY = join(import.meta.dir, "..", "index.ts");

/**
 * Write a `me` wrapper script into a scratch bin dir that execs THIS
 * checkout's `packages/cli/index.ts` (via the same Bun binary running the
 * test) — so prepending the returned dir to a spawned harness's `PATH`
 * makes its hook's `me <harness> env`/`env-hook` invocation resolve to the
 * current dev build instead of a globally-installed release.
 */
export function writeMeWrapper(): string {
  const binDir = mkdtempSync(join(tmpdir(), "me-harness-smoke-bin-"));
  const wrapperPath = join(binDir, "me");
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec "${process.execPath}" "${CLI_ENTRY}" "$@"\n`,
  );
  chmodSync(wrapperPath, 0o755);
  return binDir;
}

/** The four contract vars every adapter injects (see harness-contract.ts). */
export const CONTRACT_VAR_NAMES = [
  "ME_INJECT_V",
  "AI_AGENT",
  "ME_AS_AGENT",
  "ME_PROJECT_DIR",
] as const;

/**
 * A prompt instructing the model to reveal exactly the four contract vars
 * via the shell, verbatim — deterministic and narrow enough that any
 * capable model follows it reliably, and easy to regex out of a noisy
 * response (we don't rely on the model NOT adding extra commentary).
 */
export function markerPrompt(shellCommand: string): string {
  return (
    `Use your shell/bash tool to run exactly this command, verbatim, then reply with ONLY its raw stdout ` +
    `(no commentary, no code fences, no extra text): ${shellCommand}`
  );
}

/** The shell command the prompt asks for: prints just our four vars. */
export const REVEAL_COMMAND = `env | grep -E '^(${CONTRACT_VAR_NAMES.join("|")})='`;

/**
 * `process.env` with the four contract vars stripped. These tests may
 * themselves run inside a live-injected harness session (e.g. this very
 * Claude Code session) — spawning the harness-under-test with that ambient
 * state inherited would make first-writer-wins skip re-injection for the
 * wrong reason (an outer session's contract, not the child's own). Build
 * every smoke test's child env from this, never raw `process.env`.
 */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of CONTRACT_VAR_NAMES) delete env[key];
  return env;
}

/** Parse `KEY=value` lines (as printed by `env`) out of arbitrary text —
 * tolerant of surrounding commentary the model might add anyway. */
export function extractContractVars(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = new RegExp(`^(${CONTRACT_VAR_NAMES.join("|")})=(.*)$`);
  for (const line of text.split("\n")) {
    const match = pattern.exec(line.trim());
    if (match) found[match[1] as string] = match[2] as string;
  }
  return found;
}
