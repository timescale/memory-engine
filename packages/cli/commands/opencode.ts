/**
 * me opencode — OpenCode integration commands.
 *
 * - me opencode install: register me as an MCP server with OpenCode
 */
import { Command } from "commander";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";

function createOpenCodeInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with OpenCode")
    .option("--api-key <key>", "API key to embed in MCP config")
    .option("--server <url>", "server URL to embed in MCP config")
    .action(async (opts: AgentInstallOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      await runAgentMcpInstall("opencode", {
        apiKey: opts.apiKey,
        server: globalOpts.server ?? opts.server,
      });
    });
}

export function createOpenCodeCommand(): Command {
  const opencode = new Command("opencode").description("OpenCode integration");
  opencode.addCommand(createOpenCodeInstallCommand());
  return opencode;
}
