/**
 * me mcp — run the MCP server over stdio.
 *
 * Does NOT use the credentials file. API key must be provided
 * via --api-key or ME_API_KEY env var.
 *
 * MCP registration with individual AI tools has moved to per-agent commands:
 *   me claude install, me opencode install, me gemini install, me codex install
 */
import { Command } from "commander";
import { runMcpServer } from "../mcp/server.ts";

const DEFAULT_SERVER = "https://api.memory.build";

/**
 * me mcp — run the MCP server over stdio.
 *
 * Does NOT use the credentials file. API key must be provided
 * via --api-key or ME_API_KEY env var.
 */
function createMcpRunAction() {
  return async (_opts: Record<string, unknown>, cmd: Command) => {
    const opts = cmd.optsWithGlobals();

    // Resolve API key: --api-key > ME_API_KEY
    const apiKey =
      (opts.apiKey as string | undefined) ?? process.env.ME_API_KEY;
    if (!apiKey) {
      console.error(
        "Error: API key required. Provide via --api-key or ME_API_KEY env var.",
      );
      process.exit(1);
    }

    // Resolve server: --server > ME_SERVER > default
    const server =
      (opts.server as string | undefined) ??
      process.env.ME_SERVER ??
      DEFAULT_SERVER;

    await runMcpServer({ apiKey, server });
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
