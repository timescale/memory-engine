/**
 * Shared MCP-only install logic for per-agent commands.
 *
 * Used by `me <agent> install` stubs that register the MCP server
 * with a single AI tool (Claude Code, Gemini CLI, Codex CLI, OpenCode).
 */
import * as clack from "@clack/prompts";
import { resolveCredentials } from "../credentials.ts";
import { buildMeCommand, installMcpServer, MCP_TOOLS } from "./install.ts";

export interface AgentInstallOptions {
  apiKey?: string;
  server?: string;
  /**
   * Configuration scope for tools that support it (Claude Code, Gemini CLI).
   * Ignored by tools without a scope concept (Codex, OpenCode).
   */
  scope?: string;
}

/**
 * Run MCP-only install for a single agent tool.
 *
 * Resolves credentials, finds the tool in the registry by its binary name,
 * checks it's on PATH, and runs the MCP registration.
 */
export async function runAgentMcpInstall(
  toolBin: string,
  opts: AgentInstallOptions,
): Promise<void> {
  const tool = MCP_TOOLS.find((t) => t.bin === toolBin);
  if (!tool) {
    clack.log.error(`Unknown tool: ${toolBin}`);
    process.exit(1);
  }

  // Resolve credentials: flags > credentials file
  let { apiKey, server } = opts;
  if (!apiKey || !server) {
    const creds = resolveCredentials(server);
    if (!apiKey) apiKey = creds.apiKey;
    if (!server) server = creds.server;
  }

  if (!apiKey) {
    clack.log.error(
      "No API key available. Either pass --api-key or run 'me engine use' first.",
    );
    process.exit(1);
  }

  if (!server) {
    clack.log.error("No server URL available. Pass --server or set ME_SERVER.");
    process.exit(1);
  }

  // For CLI tools, require the binary to be on PATH. JSON-file tools
  // (e.g. OpenCode) just edit a config file and don't need the binary.
  if (tool.method === "cli" && Bun.which(tool.bin) === null) {
    clack.log.error(
      `${tool.name} (${tool.bin}) not found on PATH. Install it first.`,
    );
    process.exit(1);
  }

  // Build the me mcp command with baked-in credentials
  const meCmd = buildMeCommand(apiKey, server);

  const spin = clack.spinner();
  spin.start(`Registering with ${tool.name}...`);
  const result = await installMcpServer(tool, meCmd, { scope: opts.scope });

  if (result.success) {
    spin.stop(result.message);
  } else {
    spin.stop(`Failed: ${tool.name}`);
    clack.log.error(result.message);
    process.exit(1);
  }
}
