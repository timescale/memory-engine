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
  /** The space slug to bake into the MCP command (api keys are global). */
  space?: string;
  /**
   * Configuration scope for tools that support it (Claude Code, Gemini CLI,
   * and OpenCode — "project" vs "user"). Ignored by Codex.
   */
  scope?: string;
  /** Project root for `scope: "project"` (OpenCode). Defaults to cwd. */
  projectDir?: string;
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

  // Resolve credentials: flags > env (ME_API_KEY / ME_SERVER / ME_SPACE) >
  // stored config.
  const creds = resolveCredentials(opts.server);
  const apiKey = opts.apiKey ?? creds.apiKey; // --api-key > ME_API_KEY
  const server = opts.server ?? creds.server;

  if (!server) {
    clack.log.error("No server URL available. Pass --server or set ME_SERVER.");
    process.exit(1);
  }

  // Default path: no api key → the MCP server uses your login SESSION, resolved
  // from the keychain/config at runtime each time it starts (so it survives
  // `me login`). Pass --api-key / ME_API_KEY only for a headless agent that
  // can't reach your keychain; that bakes a long-lived global key and must pin a
  // space. The `--space` flag pins the space either way; otherwise the session
  // path resolves it at runtime from ME_SPACE / active space.
  let meCmd: string[];
  if (apiKey) {
    const space = opts.space ?? creds.activeSpace;
    if (!space) {
      clack.log.error(
        "No space for the API key. Pass --space, set ME_SPACE, or run 'me space use <space>' (keys are global, so the space must be fixed).",
      );
      process.exit(1);
    }
    meCmd = buildMeCommand({ server, apiKey, space });
  } else {
    if (!creds.loggedIn) {
      clack.log.error(
        "Not logged in. Run 'me login' (the MCP server will use your session), or pass --api-key / set ME_API_KEY for a headless agent.",
      );
      process.exit(1);
    }
    // Bake only --server (+ an explicit --space pin if given); the session token
    // and space resolve at runtime.
    meCmd = buildMeCommand({ server, space: opts.space });
    if (!opts.space && !creds.activeSpace) {
      clack.log.warn(
        "No active space set — the MCP server will fail until you run 'me space use <space>' (or set ME_SPACE). Re-run with --space to pin one.",
      );
    }
  }

  // For CLI tools, require the binary to be on PATH. JSON-file tools
  // (e.g. OpenCode) just edit a config file and don't need the binary.
  if (tool.method === "cli" && Bun.which(tool.bin) === null) {
    clack.log.error(
      `${tool.name} (${tool.bin}) not found on PATH. Install it first.`,
    );
    process.exit(1);
  }

  const spin = clack.spinner();
  spin.start(`Registering with ${tool.name}...`);
  const result = await installMcpServer(tool, meCmd, {
    scope: opts.scope,
    projectDir: opts.projectDir,
  });

  if (result.success) {
    spin.stop(result.message);
  } else {
    spin.stop(`Failed: ${tool.name}`);
    clack.log.error(result.message);
    process.exit(1);
  }
}
