/**
 * me mcp — run the MCP server over stdio.
 *
 * Authenticates to a space with either a human session (from `me login`) or an
 * agent api key, and targets the active space (the X-Me-Space). Resolution:
 *   - token: --api-key > ME_API_KEY > stored session token
 *   - space: --space > ME_SPACE > stored active space
 *
 * The common case is a logged-in human: `me mcp` just works against the active
 * space. Agents pass ME_API_KEY (keys are global, so a space must be given via
 * --space / ME_SPACE — the installers bake it in).
 *
 * MCP registration with individual AI tools lives in per-agent commands:
 *   me opencode install, me gemini install, me codex install
 * Claude Code uses the Memory Engine plugin instead of a CLI installer.
 */
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { runMcpServer } from "../mcp/server.ts";

/**
 * True if the token is a legacy 4-part api key (`me.<slug>.<lookup>.<secret>`),
 * the retired space-scoped format that no longer authenticates. Duplicated from
 * `@memory.build/engine/core`'s `isLegacyApiKey` so the CLI doesn't depend on the
 * engine package; the legacy format is frozen, so this won't drift.
 */
export function isLegacyApiKey(token: string): boolean {
  const parts = token.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "me" &&
    /^[a-z0-9]{12}$/.test(parts[1] ?? "") &&
    /^[A-Za-z0-9_-]{16}$/.test(parts[2] ?? "") &&
    (parts[3]?.length ?? 0) === 32
  );
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

    // Fail fast on a retired space-scoped key rather than starting the server and
    // failing on the first tool call with a server-side error.
    if (isLegacyApiKey(token)) {
      console.error(
        "Error: this API key uses the old space-scoped format (me.<slug>.<id>.<secret>) and no longer works. Recreate it with 'me apikey create <agent>', then update ME_API_KEY or your MCP config.",
      );
      process.exit(1);
    }

    // Space: --space > ME_SPACE / stored active space.
    const space = (opts.space as string | undefined) ?? creds.activeSpace;
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
