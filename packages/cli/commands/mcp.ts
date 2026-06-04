/**
 * me mcp — run the MCP server over stdio.
 *
 * Authenticates to a space with either a human session (from `me login`) or an
 * agent api key, and targets the active space (the X-Me-Space). Resolution:
 *   - token: --api-key > ME_API_KEY > stored session token
 *   - space: --space > ME_SPACE > stored active space > the api key's own slug
 *
 * The common case is a logged-in human: `me mcp` just works against the active
 * space. Agents pass ME_API_KEY (the key embeds its space, so --space is
 * optional).
 *
 * MCP registration with individual AI tools lives in per-agent commands:
 *   me opencode install, me gemini install, me codex install
 * Claude Code uses the Memory Engine plugin instead of a CLI installer.
 */
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { runMcpServer } from "../mcp/server.ts";

/** Extract the space slug embedded in an api key (`me.<slug>.<lookup>.<secret>`). */
function slugFromApiKey(token: string): string | undefined {
  if (!token.startsWith("me.")) return undefined;
  const parts = token.split(".");
  return parts.length >= 4 ? parts[1] : undefined;
}

function createMcpRunAction() {
  return async (_opts: Record<string, unknown>, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    const creds = resolveCredentials(opts.server as string | undefined);

    // Token: --api-key > ME_API_KEY (creds.apiKey) > stored session token.
    const token =
      (opts.apiKey as string | undefined) ?? creds.apiKey ?? creds.sessionToken;
    if (!token) {
      console.error(
        "Error: no credentials. Run 'me login', or pass --api-key / set ME_API_KEY.",
      );
      process.exit(1);
    }

    // Space: --space > ME_SPACE / stored active space > the api key's own slug.
    const space =
      (opts.space as string | undefined) ??
      creds.activeSpace ??
      slugFromApiKey(token);
    if (!space) {
      console.error(
        "Error: no active space. Run 'me space use <space>', or pass --space / set ME_SPACE.",
      );
      process.exit(1);
    }

    await runMcpServer({ server: creds.server, token, space });
  };
}

export function createMcpCommand(): Command {
  return new Command("mcp")
    .description("run MCP server over stdio")
    .option("--api-key <key>", "agent api key (else uses the stored session)")
    .option(
      "--space <slug>",
      "active space (else ME_SPACE / stored active space)",
    )
    .action(createMcpRunAction());
}
