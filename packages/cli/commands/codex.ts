/**
 * me codex — Codex CLI integration commands.
 *
 * - me codex install: register me as an MCP server with Codex CLI
 */
import { Command } from "commander";
import { codexImporter } from "../importers/codex.ts";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";
import { buildAgentImportSubcommand } from "./import.ts";

function createCodexInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with Codex CLI")
    .option(
      "--api-key <key>",
      "API key for a headless agent (default: use your login session at runtime)",
    )
    .option("--server <url>", "server URL to embed in MCP config")
    .option(
      "--space <slug>",
      "pin a space (default: resolve ME_SPACE / active space at runtime)",
    )
    .action(async (opts: AgentInstallOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      await runAgentMcpInstall("codex", {
        apiKey: opts.apiKey,
        server: globalOpts.server ?? opts.server,
        space: opts.space,
      });
    });
}

export function createCodexCommand(): Command {
  const codex = new Command("codex").description("Codex CLI integration");
  codex.addCommand(createCodexInstallCommand());
  codex.addCommand(
    buildAgentImportSubcommand(
      "import Codex sessions from ~/.codex/sessions and archived_sessions",
      codexImporter,
    ),
  );
  return codex;
}
