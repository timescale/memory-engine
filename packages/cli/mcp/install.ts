/**
 * MCP install logic — tool detection, command building, and registration.
 *
 * Detects AI tools on PATH and registers `me` as an MCP server
 * by running each tool's `mcp add` command.
 */
import { join, resolve } from "node:path";

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

interface McpToolManual extends McpToolBase {
  method: "manual";
  instruction: string;
}

type McpTool = McpToolCli | McpToolManual;

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
    method: "manual",
    instruction: "opencode mcp add",
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
 * Check if we're running as a compiled binary.
 */
function isCompiledBinary(): boolean {
  return !process.argv[0]?.includes("bun");
}

/**
 * Get the binary path for the `me` command.
 */
function getBinaryPath(): string {
  return process.argv[0] ?? "me";
}

/**
 * Build the `me mcp` command array with baked-in credentials.
 *
 * Compiled: ["/path/to/me", "mcp", "--api-key", "...", "--server", "..."]
 * Dev:     ["bun", "/abs/path/to/index.ts", "mcp", "--api-key", "...", "--server", "..."]
 */
export function buildMeCommand(apiKey: string, serverUrl: string): string[] {
  const base = isCompiledBinary()
    ? [getBinaryPath(), "mcp"]
    : ["bun", resolve(join(__dirname, "..", "index.ts")), "mcp"];

  base.push("--api-key", apiKey);
  base.push("--server", serverUrl);

  return base;
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
  return { success: true, message: tool.instruction };
}
