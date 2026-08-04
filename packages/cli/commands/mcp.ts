/**
 * me mcp — run the MCP server over stdio.
 *
 * Authenticates to a space with either a human session (from `me login`) or an
 * API key. Resolution:
 *   - token: --api-key > ME_API_KEY > stored session token
 *   - space: --space > ME_SPACE (locked), otherwise multi-space
 *
 * An unpinned MCP server is always multi-space and tools require a space
 * argument. API-key installers can also run multi-space; --space stays opt-in.
 *
 * MCP registration with individual AI tools lives in per-agent commands:
 *   me opencode install, me gemini install, me codex install
 * Claude Code uses the Memory Engine plugin instead of a CLI installer.
 */
import { Command } from "commander";
import {
  type ResolvedCredentials,
  resolveCredentials,
} from "../credentials.ts";
import { HARNESS_NAMES, type HarnessName } from "../harness/names.ts";
import { resolveMcpProfile } from "../local-config.ts";
import { type McpSpaceSelection, runMcpServer } from "../mcp/server.ts";
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
 * Treat unset / empty / whitespace-only / unsubstituted-placeholder flag values
 * as missing. The Claude Code plugin's .mcp.json passes `--server/--api-key/
 * --space ${user_config.X}` statically; when left blank each arrives as `""`
 * (or the literal `${...}` placeholder), which must fall through to the live
 * `me` server/session config, not be used verbatim. Whitespace-only strings —
 * e.g. `ME_SPACE=" "` — are treated as blank, and any legitimate value is
 * trimmed so an accidental leading/trailing space cannot corrupt the wire.
 */
export function blankFlag(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (trimmed === "" || /^\$\{.*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Resolve the MCP mode. Explicit process configuration is a capability-surface
 * choice: a flag or ME_SPACE locks the schemas; otherwise every memory tool
 * requires a per-call space.
 */
export function resolveMcpSpace(
  flagValue: unknown,
  envSpace: string | undefined,
): McpSpaceSelection {
  const explicitSpace = blankFlag(flagValue) ?? blankFlag(envSpace);
  if (explicitSpace) {
    return { spaceMode: "locked", lockedSpace: explicitSpace };
  }
  return { spaceMode: "multi" };
}

interface McpRunActionDependencies {
  resolveCredentials: (serverFlag?: string) => ResolvedCredentials;
  memoryBearer: typeof memoryBearer;
  runMcpServer: typeof runMcpServer;
}

export function createMcpRunAction(
  dependencies: McpRunActionDependencies = {
    resolveCredentials,
    memoryBearer,
    runMcpServer,
  },
) {
  return async (_opts: Record<string, unknown>, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    const agent = process.env.AI_AGENT;
    const harness =
      agent && HARNESS_NAMES.includes(agent as HarnessName)
        ? (agent as HarnessName)
        : undefined;
    const policy = harness ? resolveMcpProfile(process.cwd()).value : undefined;
    if (!policy?.enabled || !harness || policy.harnesses[harness] !== true) {
      await dependencies.runMcpServer({
        server: "https://api.memory.build",
        bearer: {
          getToken: async () => undefined,
          onUnauthorized: async () => undefined,
        },
        spaceMode: "multi",
        tools: false,
      });
      return;
    }
    // Run server through blankFlag like api_key/space below: the plugin's
    // .mcp.json always passes `--server ${user_config.server}`, which arrives as
    // "" (or the literal placeholder) when left blank — it must fall back to the
    // live `me` config (ME_SERVER / default_server), not be used verbatim.
    const creds = dependencies.resolveCredentials(
      blankFlag(opts.server) ?? policy.server,
    );

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
        "Error: this API key uses the old space-scoped format (me.<slug>.<id>.<secret>) and no longer works. Recreate it with 'me apikey create', then update ME_API_KEY or your MCP config.",
      );
      process.exit(1);
    }

    const space = resolveMcpSpace(
      opts.space,
      process.env.ME_SPACE ?? policy.space,
    );

    await dependencies.runMcpServer({
      server: creds.server,
      bearer: dependencies.memoryBearer(creds.server, apiKey),
      ...space,
    });
  };
}

export function createMcpCommand(): Command {
  return new Command("mcp")
    .description("run MCP server over stdio")
    .option("--api-key <key>", "API key (else uses the stored session)")
    .option(
      "--space <slug>",
      "lock MCP to this space (else memory tools require a per-call space)",
    )
    .action(createMcpRunAction());
}
