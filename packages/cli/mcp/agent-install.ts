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
 * When an install bakes no `--space`, the runtime MCP server starts in
 * multi-space mode and agents must call `me_space_list` + pass `space` on
 * every memory tool. Return the warn string in that case (both session and
 * api-key installs behave the same at runtime), or undefined when a space
 * pin will lock the server. Exposed pure for testability.
 */
export function multiSpaceWarning(
  space: string | undefined,
): string | undefined {
  if (space?.trim()) return undefined;
  return "No MCP space pinned — the server will start in multi-space mode. Agents must call me_space_list, then pass space to every memory tool. Re-run with --space to pin one.";
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

  // The MCP server resolves a login session from the keychain/config at runtime,
  // so a personal install survives `me login`. API keys are also global and may
  // run multi-space. Only an explicit --space pins either credential type.
  let meCmd: string[];
  if (apiKey) {
    meCmd = buildMeCommand({ server, apiKey, space: opts.space });
  } else {
    if (!creds.loggedIn) {
      clack.log.error(
        "Not logged in. Run 'me login' (the MCP server will use your session), or pass --api-key / set ME_API_KEY for headless/CI use.",
      );
      process.exit(1);
    }
    // Bake only --server (+ an explicit --space pin if given); the session token
    // resolves at runtime and an unpinned server is multi-space.
    meCmd = buildMeCommand({ server, space: opts.space });
  }

  // Emit the multi-space notice on both credential paths: an unpinned MCP is
  // multi-space regardless of whether it uses a session or an api key.
  const warning = multiSpaceWarning(opts.space);
  if (warning) clack.log.warn(warning);

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
