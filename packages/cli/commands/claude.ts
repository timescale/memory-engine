/**
 * me claude — Claude Code integration commands.
 *
 * - me claude install:   install Memory Engine plugin (Phase 1: MCP-only stub)
 * - me claude uninstall: remove plugin (Phase 4)
 * - me claude hook:      invoked by plugin hooks (Phase 3)
 */
import { Command } from "commander";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";

function createClaudeInstallCommand(): Command {
  return new Command("install")
    .description("install Memory Engine plugin for Claude Code")
    .option("--api-key <key>", "API key to embed in MCP config")
    .option("--server <url>", "server URL to embed in MCP config")
    .action(async (opts: AgentInstallOptions, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      // Phase 1: MCP-only stub. Phase 2 replaces with full wizard.
      await runAgentMcpInstall("claude", {
        apiKey: opts.apiKey,
        server: globalOpts.server ?? opts.server,
      });
    });
}

export function createClaudeCommand(): Command {
  const claude = new Command("claude").description("Claude Code integration");
  claude.addCommand(createClaudeInstallCommand());
  return claude;
}
