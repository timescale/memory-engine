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
  },
  {
    name: "Codex CLI",
    bin: "codex",
    method: "cli",
    addCmd: (meCmd) => ["codex", "mcp", "add", "me", "--", ...meCmd],
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
export function buildMeCommand(apiKey: string, serverUrl?: string): string[] {
  const base = isCompiledBinary()
    ? [getBinaryPath(), "mcp"]
    : ["bun", resolve(join(__dirname, "..", "index.ts")), "mcp"];

  base.push("--api-key", apiKey);
  if (serverUrl) {
    base.push("--server", serverUrl);
  }

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
 * Install MCP server via a tool's CLI `mcp add` command.
 */
async function installViaCli(
  tool: McpToolCli,
  meCmd: string[],
): Promise<InstallResult> {
  const cmd = tool.addCmd(meCmd);
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    return { success: true, message: `Registered with ${tool.name}` };
  }

  const stderr = await new Response(proc.stderr).text();

  // Treat "already exists" as success
  if (stderr.includes("already exists")) {
    return { success: true, message: `Already registered with ${tool.name}` };
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
