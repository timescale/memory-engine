/**
 * me mcp: run the MCP server over stdio.
 *
 * MCP registration with individual AI tools lives in per-agent commands:
 *   me opencode install, me gemini install, me codex install
 * Claude Code uses the Memory Engine plugin instead of a CLI installer.
 */
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { runMcpServer } from "../mcp/server.ts";

function createMcpRunAction() {
  return async (_opts: Record<string, unknown>, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    const creds = resolveCredentials(opts.server as string | undefined);
    const apiKey = (opts.apiKey as string | undefined) || creds.apiKey;
    await runMcpServer({
      apiKey,
      server: creds.server,
      sessionToken: creds.sessionToken,
    });
  };
}

/**
 * Create the MCP command.
 */
export function createMcpCommand(): Command {
  return new Command("mcp")
    .description("run MCP server over stdio")
    .option("--api-key <key>", "API key for engine authentication")
    .action(createMcpRunAction());
}
