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
 *   me opencode install, me codex install
 * Claude Code uses the Memory Engine plugin instead of a CLI installer.
 */
import { Command, InvalidArgumentError, Option } from "commander";
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
 * Treat unset / empty / whitespace-only / unsubstituted-placeholder values as
 * missing. Managed registrations bake no `--server`/`--api-key`/`--space`, but
 * env (`ME_SERVER` / `ME_SPACE`) and a manually-configured MCP entry can still
 * arrive as `""` (or a literal `${...}` placeholder from a templated config),
 * which must fall through to the live `me` server/session config rather than be
 * used verbatim. Whitespace-only strings — e.g. `ME_SPACE=" "` — are treated as
 * blank, and any legitimate value is trimmed so an accidental leading/trailing
 * space cannot corrupt the wire.
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
  resolveMcpProfile: typeof resolveMcpProfile;
  memoryBearer: typeof memoryBearer;
  runMcpServer: typeof runMcpServer;
}

export function createMcpRunAction(
  dependencies: McpRunActionDependencies = {
    resolveCredentials,
    resolveMcpProfile,
    memoryBearer,
    runMcpServer,
  },
) {
  return async (_opts: Record<string, unknown>, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    const harness = resolveManagedHarness(opts.harness);
    let policy: ReturnType<typeof resolveMcpProfile>["value"];
    try {
      policy = harness
        ? dependencies.resolveMcpProfile(
            process.env.ME_PROJECT_DIR ?? process.cwd(),
          ).value
        : undefined;
    } catch {
      // A malformed local policy fails closed: keep the dispatcher alive with
      // no tools rather than breaking the harness session.
      policy = undefined;
    }
    if (harness && (!policy?.enabled || policy.harnesses[harness] !== true)) {
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
    // Server precedence mirrors space below: --server flag > ME_SERVER env >
    // MCP-profile policy > live `me` config default. `blankFlag` normalizes both
    // the flag and the env (blank / whitespace / unsubstituted `${...}` →
    // undefined) so an accidentally-empty value falls through instead of being
    // used verbatim; the managed profile's server is only a fallback below env.
    const creds = dependencies.resolveCredentials(
      blankFlag(opts.server) ??
        blankFlag(process.env.ME_SERVER) ??
        policy?.server,
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
      process.env.ME_SPACE ?? policy?.space,
    );

    await dependencies.runMcpServer({
      server: creds.server,
      bearer: dependencies.memoryBearer(creds.server, apiKey),
      ...space,
    });
  };
}

/** Validate the installer-owned harness identity on a managed MCP process. */
export function resolveManagedHarness(value: unknown): HarnessName | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !HARNESS_NAMES.includes(value as HarnessName)
  ) {
    throw new InvalidArgumentError(
      `invalid managed harness '${String(value)}'`,
    );
  }
  return value as HarnessName;
}

export function createMcpCommand(): Command {
  return new Command("mcp")
    .description("run MCP server over stdio")
    .option("--api-key <key>", "API key (else uses the stored session)")
    .option(
      "--space <slug>",
      "lock MCP to this space (else memory tools require a per-call space)",
    )
    .addOption(
      new Option(
        "--harness <name>",
        "internal managed-harness identity",
      ).hideHelp(),
    )
    .action(createMcpRunAction());
}
