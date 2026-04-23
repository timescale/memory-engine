/**
 * me codex — Codex CLI integration commands.
 *
 * - me codex install: register me as an MCP server with Codex CLI
 */
import { Command } from "commander";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";

function createCodexInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with Codex CLI")
    .option("--api-key <key>", "API key to embed in MCP config")
    .option("--server <url>", "server URL to embed in MCP config")
    .action(async (opts: AgentInstallOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      await runAgentMcpInstall("codex", {
        apiKey: opts.apiKey,
        server: globalOpts.server ?? opts.server,
      });
    });
}

export function createCodexCommand(): Command {
  const codex = new Command("codex").description("Codex CLI integration");
  codex.addCommand(createCodexInstallCommand());
  return codex;
}
