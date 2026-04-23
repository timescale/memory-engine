/**
 * me gemini — Gemini CLI integration commands.
 *
 * - me gemini install: register me as an MCP server with Gemini CLI
 */
import { Command } from "commander";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";

function createGeminiInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with Gemini CLI")
    .option("--api-key <key>", "API key to embed in MCP config")
    .option("--server <url>", "server URL to embed in MCP config")
    .action(async (opts: AgentInstallOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      await runAgentMcpInstall("gemini", {
        apiKey: opts.apiKey,
        server: globalOpts.server ?? opts.server,
      });
    });
}

export function createGeminiCommand(): Command {
  const gemini = new Command("gemini").description("Gemini CLI integration");
  gemini.addCommand(createGeminiInstallCommand());
  return gemini;
}
