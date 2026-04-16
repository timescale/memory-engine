/**
 * me mcp — MCP server commands.
 *
 * - me mcp: Run as MCP server (stdio transport)
 * - me mcp install [tools...]: Register with AI tools
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import {
  buildMeCommand,
  detectInstalledTools,
  type InstallResult,
  installMcpServer,
} from "../mcp/install.ts";
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
 * me mcp install — register me as an MCP server with AI tools.
 *
 * Uses the credentials file as a convenience for defaults.
 * Bakes the API key and server URL into the MCP config.
 */
function createMcpInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with AI tools")
    .argument("[tools...]", "tool names to install (default: all detected)")
    .option("--api-key <key>", "API key to embed in MCP config")
    .option("--server <url>", "server URL to embed in MCP config")
    .action(async (toolNames: string[], opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();

      // Resolve API key: --api-key > active engine from credentials
      let apiKey = opts.apiKey as string | undefined;
      let serverUrl = (globalOpts.server as string | undefined) ?? opts.server;

      if (!apiKey || !serverUrl) {
        // Fall back to credentials file — use the effective server
        // (global --server, local --server, or undefined for default resolution)
        const creds = resolveCredentials(serverUrl);
        if (!apiKey) apiKey = creds.apiKey;
        if (!serverUrl) serverUrl = creds.server;
      }

      if (!apiKey) {
        clack.log.error(
          "No API key available. Either pass --api-key or run 'me engine use' first.",
        );
        process.exit(1);
      }

      if (!serverUrl) {
        clack.log.error(
          "No server URL available. Pass --server or set ME_SERVER.",
        );
        process.exit(1);
      }

      // Detect tools
      const detected = detectInstalledTools();
      let tools = detected;

      if (toolNames.length > 0) {
        // Filter to named tools
        const nameSet = new Set(toolNames.map((n) => n.toLowerCase()));
        tools = detected.filter(
          (t) =>
            nameSet.has(t.name.toLowerCase()) ||
            nameSet.has(t.bin.toLowerCase()),
        );

        const found = new Set(tools.map((t) => t.bin.toLowerCase()));
        for (const name of toolNames) {
          if (
            !found.has(name.toLowerCase()) &&
            !tools.some((t) => t.name.toLowerCase() === name.toLowerCase())
          ) {
            clack.log.warn(`Tool '${name}' not found or not installed.`);
          }
        }
      }

      if (tools.length === 0) {
        clack.log.warn("No supported AI tools detected on PATH.");
        clack.note(
          [
            "To manually register me as an MCP server:",
            "  claude mcp add --scope user me -- me mcp --api-key <key>",
            "  gemini mcp add --scope user me me mcp --api-key <key>",
            "  codex mcp add me -- me mcp --api-key <key>",
            "  opencode mcp add",
          ].join("\n"),
          "Manual Install",
        );
        return;
      }

      // Build command with baked-in credentials
      const meCmd = buildMeCommand(apiKey, serverUrl);

      // Install each tool
      const results: Array<{ name: string } & InstallResult> = [];
      const manualInstructions: string[] = [];

      for (const tool of tools) {
        if (tool.method === "manual") {
          manualInstructions.push(`  ${tool.name}: ${tool.instruction}`);
          continue;
        }

        const spin = clack.spinner();
        spin.start(`Registering with ${tool.name}...`);
        const result = await installMcpServer(tool, meCmd);
        results.push({ name: tool.name, ...result });
        spin.stop(
          result.success
            ? `Registered with ${tool.name}`
            : `Failed: ${tool.name}`,
        );

        if (!result.success) {
          clack.log.warn(result.message);
        }
      }

      if (manualInstructions.length > 0) {
        clack.note(
          ["Register manually:", ...manualInstructions].join("\n"),
          "MCP",
        );
      }

      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        process.exit(1);
      }
    });
}

/**
 * Create the MCP command group.
 */
export function createMcpCommand(): Command {
  const mcp = new Command("mcp")
    .description("MCP server for AI tool integration")
    .option("--api-key <key>", "API key for engine authentication")
    .action(createMcpRunAction());

  mcp.addCommand(createMcpInstallCommand());

  return mcp;
}
