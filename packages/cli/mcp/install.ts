/**
 * MCP install logic — tool detection, command building, and registration.
 *
 * Detects AI tools on PATH and registers `me` as an MCP server
 * by running each tool's `mcp add` command or editing its JSON config.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// =============================================================================
// Tool Registry
// =============================================================================

interface McpToolBase {
  name: string;
  bin: string;
}

interface McpToolCli extends McpToolBase {
  method: "cli";
  addCmd: (meCmd: string[]) => string[];
  removeCmd: string[];
}

interface McpToolJsonFile extends McpToolBase {
  method: "json-file";
  install: (meCmd: string[]) => Promise<InstallResult>;
}

type McpTool = McpToolCli | McpToolJsonFile;

export const MCP_TOOLS: McpTool[] = [
  {
    name: "Claude Code",
    bin: "claude",
    method: "cli",
    addCmd: (meCmd) => [
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "me",
      "--",
      ...meCmd,
    ],
    removeCmd: ["claude", "mcp", "remove", "--scope", "user", "me"],
  },
  {
    name: "Gemini CLI",
    bin: "gemini",
    method: "cli",
    addCmd: (meCmd) => [
      "gemini",
      "mcp",
      "add",
      "--scope",
      "user",
      "me",
      ...meCmd,
    ],
    removeCmd: ["gemini", "mcp", "remove", "--scope", "user", "me"],
  },
  {
    name: "Codex CLI",
    bin: "codex",
    method: "cli",
    addCmd: (meCmd) => ["codex", "mcp", "add", "me", "--", ...meCmd],
    removeCmd: ["codex", "mcp", "remove", "me"],
  },
  {
    name: "OpenCode",
    bin: "opencode",
    method: "json-file",
    install: installOpenCode,
  },
];

// =============================================================================
// Detection & Command Building
// =============================================================================

/**
 * Detect which MCP-capable tools are installed on PATH.
 */
export function detectInstalledTools(): McpTool[] {
  return MCP_TOOLS.filter((tool) => Bun.which(tool.bin) !== null);
}

/**
 * Build the `me mcp` command array with baked-in credentials.
 *
 * Always uses bare `me` — the binary is expected to be on PATH
 * whether installed via the install script, Homebrew, or npm.
 */
export function buildMeCommand(apiKey: string, serverUrl: string): string[] {
  return ["me", "mcp", "--api-key", apiKey, "--server", serverUrl];
}

// =============================================================================
// Installation
// =============================================================================

export interface InstallResult {
  success: boolean;
  message: string;
}

/**
 * Run an mcp add command and return the exit code + stderr.
 */
async function runAddCmd(
  tool: McpToolCli,
  meCmd: string[],
): Promise<{ exitCode: number; stderr: string }> {
  const cmd = tool.addCmd(meCmd);
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stderr = exitCode === 0 ? "" : await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

/**
 * Install MCP server via a tool's CLI `mcp add` command.
 *
 * If a prior registration exists, removes it first and re-adds
 * so that credentials and command args are always up to date.
 */
async function installViaCli(
  tool: McpToolCli,
  meCmd: string[],
): Promise<InstallResult> {
  let { exitCode, stderr } = await runAddCmd(tool, meCmd);

  if (exitCode === 0) {
    return { success: true, message: `Registered with ${tool.name}` };
  }

  // Prior registration exists — remove it and re-add with current credentials
  if (stderr.includes("already exists")) {
    const rm = Bun.spawn(tool.removeCmd, { stdout: "pipe", stderr: "pipe" });
    await rm.exited;

    ({ exitCode, stderr } = await runAddCmd(tool, meCmd));

    if (exitCode === 0) {
      return {
        success: true,
        message: `Updated registration for ${tool.name}`,
      };
    }
  }

  return {
    success: false,
    message: `${tool.name}: command exited with code ${exitCode}${stderr ? ` — ${stderr.trim()}` : ""}`,
  };
}

/**
 * Install MCP server for a single tool, dispatching by method.
 */
export async function installMcpServer(
  tool: McpTool,
  meCmd: string[],
): Promise<InstallResult> {
  if (tool.method === "cli") {
    return installViaCli(tool, meCmd);
  }
  return tool.install(meCmd);
}

// =============================================================================
// OpenCode installer
// =============================================================================

/**
 * Path to OpenCode's config file.
 */
export function openCodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/**
 * Pure helper: merge the `me` MCP entry into an existing OpenCode
 * config object. Returns the updated config and whether a prior entry existed.
 *
 * Exported for testability — the install function layers file I/O on top.
 */
export function buildOpenCodeConfig(
  existing: Record<string, unknown>,
  meCmd: string[],
): { config: Record<string, unknown>; existed: boolean } {
  const currentMcp = existing.mcp;
  const mcp =
    currentMcp && typeof currentMcp === "object" && !Array.isArray(currentMcp)
      ? { ...(currentMcp as Record<string, unknown>) }
      : {};

  const existed = "me" in mcp;
  mcp.me = {
    type: "local",
    command: meCmd,
  };

  return {
    config: { ...existing, mcp },
    existed,
  };
}

/**
 * Register Memory Engine in OpenCode's JSON config.
 *
 * Creates the config file and its parent directory if missing.
 * Preserves any other keys in the existing config.
 */
async function installOpenCode(meCmd: string[]): Promise<InstallResult> {
  const configPath = openCodeConfigPath();

  let existing: Record<string, unknown> = {};
  try {
    const contents = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(contents);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        success: false,
        message: `OpenCode: ${configPath} is not a JSON object`,
      };
    }
    existing = parsed as Record<string, unknown>;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `OpenCode: failed to read ${configPath} — ${msg}`,
      };
    }
    // File doesn't exist — start with an empty config.
  }

  const { config, existed } = buildOpenCodeConfig(existing, meCmd);

  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `OpenCode: failed to write ${configPath} — ${msg}`,
    };
  }

  return {
    success: true,
    message: existed
      ? "Updated registration for OpenCode"
      : "Registered with OpenCode",
  };
}
