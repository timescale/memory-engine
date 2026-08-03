/**
 * me codex — Codex CLI integration commands.
 *
 * - me codex install: register me as an MCP server with Codex CLI, and wire
 *   the harness-injected shell contract via a user-scope PreToolUse hook.
 * - me codex env-hook: invoked by that hook to rewrite Bash commands.
 */
import { Command } from "commander";
import { CLIENT_VERSION } from "../../../version";
import { buildCodexEnvHookOutput } from "../codex/env-hook.ts";
import {
  installCodexIntegration,
  uninstallCodexIntegration,
} from "../codex/install.ts";
import {
  getInstallation,
  removeInstallation,
  writeInstallation,
} from "../harness/installations.ts";
import { logUnrecognizedPayloadShape } from "../harness-shape-log.ts";
import { createCodexImportCommand } from "./import.ts";

function createCodexInstallCommand(): Command {
  return new Command("install")
    .description("install Memory Engine's dormant Codex CLI integration")
    .action(async () => {
      const result = await installCodexIntegration(getInstallation("codex"));
      writeInstallation("codex", {
        installed_at: new Date().toISOString(),
        me_version: CLIENT_VERSION,
        artifacts: result.artifacts,
      });
      for (const message of result.messages) console.log(message);
    });
}

function createCodexUninstallCommand(): Command {
  return new Command("uninstall")
    .description("uninstall the recorded Codex CLI integration")
    .action(async () => {
      const record = getInstallation("codex");
      if (!record) return;
      const result = await uninstallCodexIntegration(record);
      if (result.retained.length === 0) removeInstallation("codex");
      for (const message of result.messages) console.log(message);
    });
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
  codex.addCommand(createCodexUninstallCommand());
  codex.addCommand(createCodexEnvHookCommand());
  codex.addCommand(createCodexImportCommand());
  return codex;
}
