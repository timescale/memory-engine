/**
 * me gemini — Gemini CLI integration commands.
 *
 * - me gemini install: register me as an MCP server with Gemini CLI
 */
import { Command, InvalidArgumentError } from "commander";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";

const GEMINI_SCOPES = ["user", "project"] as const;
type GeminiScope = (typeof GEMINI_SCOPES)[number];

function parseGeminiScope(value: string): GeminiScope {
  if (!GEMINI_SCOPES.includes(value as GeminiScope)) {
    throw new InvalidArgumentError(
      `must be one of: ${GEMINI_SCOPES.join(", ")}`,
    );
  }
  return value as GeminiScope;
}

function createGeminiInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with Gemini CLI")
    .option("--api-key <key>", "API key to embed in MCP config")
    .option("--server <url>", "server URL to embed in MCP config")
    .option(
      "-s, --scope <scope>",
      `Gemini CLI config scope (${GEMINI_SCOPES.join(", ")})`,
      parseGeminiScope,
      "user",
    )
    .action(
      async (
        opts: AgentInstallOptions & { scope: GeminiScope },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        await runAgentMcpInstall("gemini", {
          apiKey: opts.apiKey,
          server: globalOpts.server ?? opts.server,
          scope: opts.scope,
        });
      },
    );
}

export function createGeminiCommand(): Command {
  const gemini = new Command("gemini").description("Gemini CLI integration");
  gemini.addCommand(createGeminiInstallCommand());
  return gemini;
}
