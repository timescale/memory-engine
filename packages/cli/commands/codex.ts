/**
 * me codex — Codex CLI integration commands.
 *
 * - me codex install: register me as an MCP server with Codex CLI, and wire
 *   the harness-injected shell contract via a user-scope PreToolUse hook.
 * - me codex env-hook: invoked by that hook to rewrite Bash commands.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { buildCodexEnvHookOutput } from "../codex/env-hook.ts";
import {
  type JsonHookEntry,
  upsertJsonHooksFile,
} from "../harness-hooks-json.ts";
import { logUnrecognizedPayloadShape } from "../harness-shape-log.ts";
import { createCodexImportCommand } from "./import.ts";
import {
  createHarnessInstallCommand,
  createHarnessUninstallCommand,
} from "./install.ts";

/** The hook command Codex invokes — bare, no version string, so its trust
 * hash survives a `me` upgrade (see harness-hooks-json.ts's module doc). */
const CODEX_ENV_HOOK_COMMAND = "me codex env-hook";

/** Our canonical PreToolUse hook definition — kept as one literal so every
 * install writes byte-identical JSON. */
const CODEX_HOOK_ENTRY: JsonHookEntry = {
  matcher: "^Bash$",
  hooks: [{ type: "command", command: CODEX_ENV_HOOK_COMMAND, timeout: 10 }],
};

/**
 * Write (or refresh) the user-scope `~/.codex/hooks.json` PreToolUse entry.
 * Codex trusts hooks per definition hash and gates new/changed ones behind
 * the `/hooks` approval flow — so a fresh install needs a one-time
 * `/hooks` inside Codex before the injected contract goes live.
 */
export function installCodexEnvHook(): void {
  const path = join(homedir(), ".codex", "hooks.json");
  const { changed } = upsertJsonHooksFile(
    path,
    "PreToolUse",
    CODEX_HOOK_ENTRY,
    CODEX_ENV_HOOK_COMMAND,
  );
  if (changed) {
    clack.log.success(`Installed the Codex PreToolUse hook → ${path}`);
    clack.log.info(
      "One-time step: run `/hooks` inside Codex to trust it (new hooks are held for review until then).",
    );
  }
}

function createCodexInstallCommand(): Command {
  return createHarnessInstallCommand("codex");
}

/**
 * me codex env-hook — invoked by the PreToolUse hook installed above.
 * Reads the payload from stdin, and for a Bash tool call prints a rewrite
 * that prepends the harness contract's `export …; ` prefix to the command.
 * Fails open (empty stdout) on anything it doesn't recognize — a malformed
 * payload, or a shape update from Codex — logging the shape (never command
 * content) so a later `me doctor` can flag it. Always exits 0: a hook
 * failure must never block a Codex turn.
 */
function createCodexEnvHookCommand(): Command {
  return new Command("env-hook")
    .description(
      "invoked by Codex's PreToolUse hook to inject the harness contract into Bash commands",
    )
    .action(async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(await Bun.stdin.text());
      } catch {
        logUnrecognizedPayloadShape("codex", undefined);
        process.exit(0);
      }

      const result = buildCodexEnvHookOutput(payload, process.env);
      if (result.unrecognizedShape) {
        logUnrecognizedPayloadShape("codex", payload);
      }
      if (result.output) {
        console.log(JSON.stringify(result.output));
      }
      process.exit(0);
    });
}

export function createCodexCommand(): Command {
  const codex = new Command("codex").description("Codex CLI integration");
  codex.addCommand(createCodexInstallCommand());
  codex.addCommand(createHarnessUninstallCommand("codex"));
  codex.addCommand(createCodexEnvHookCommand());
  codex.addCommand(createCodexImportCommand());
  return codex;
}
