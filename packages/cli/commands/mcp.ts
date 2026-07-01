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
import { resolveAgent, resolveCredentials } from "../credentials.ts";
import { runMcpServer } from "../mcp/server.ts";
import { memoryBearer } from "../session.ts";

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

/**
 * Treat unset / empty / unsubstituted-placeholder flag values as missing. The
 * Claude Code plugin's .mcp.json passes `--server/--api-key/--space
 * ${user_config.X}` statically; when left blank each arrives as `""` (or the
 * literal `${...}` placeholder), which must fall through to the live `me` config
 * (server/session/active space), not be used verbatim.
 */
export function blankFlag(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "" || /^\$\{.*\}$/.test(v))
    return undefined;
  return v;
}

function createMcpRunAction() {
  return async (_opts: Record<string, unknown>, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    // Run server through blankFlag like api_key/space below: the plugin's
    // .mcp.json always passes `--server ${user_config.server}`, which arrives as
    // "" (or the literal placeholder) when left blank — it must fall back to the
    // live `me` config (ME_SERVER / default_server), not be used verbatim.
    const creds = resolveCredentials(blankFlag(opts.server));

    // Bearer: --api-key > ME_API_KEY (creds.apiKey), else the logged-in human's
    // OAuth session (resolved + refreshed at runtime by `memoryBearer`).
    const apiKey = blankFlag(opts.apiKey) ?? creds.apiKey;
    if (!apiKey && !creds.loggedIn) {
      console.error(
        "Error: no credentials. Run 'me login', or pass --api-key / set ME_API_KEY.",
      );
      process.exit(1);
    }

    // Fail fast on a retired space-scoped key rather than starting the server and
    // failing on the first tool call with a server-side error. (Only an api key
    // can take this shape; a session token never does.)
    if (apiKey && isLegacyApiKey(apiKey)) {
      console.error(
        "Error: this API key uses the old space-scoped format (me.<slug>.<id>.<secret>) and no longer works. Recreate it with 'me apikey create --agent <agent>', then update ME_API_KEY or your MCP config.",
      );
      process.exit(1);
    }

    // Space: --space > ME_SPACE / stored active space.
    const space = blankFlag(opts.space) ?? creds.activeSpace;
    if (!space) {
      console.error(
        "Error: no active space. Run 'me space use <space>', or pass --space / set ME_SPACE.",
      );
      process.exit(1);
    }

    // Agent (X-Me-Agent): --agent <id|name> / ME_AGENT. Strings run through
    // blankFlag (the plugin may pass a `${user_config.agent}` placeholder); a
    // bare `--agent` (boolean true) is passed through so resolveAgent reports the
    // not-yet-implemented `.me/` path rather than silently ignoring it.
    const agentFlag =
      typeof opts.agent === "string" ? blankFlag(opts.agent) : opts.agent;
    const agent = resolveAgent(agentFlag);

    await runMcpServer({
      server: creds.server,
      bearer: memoryBearer(creds.server, apiKey),
      space,
      agent,
    });
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
