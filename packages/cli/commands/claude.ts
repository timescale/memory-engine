/**
 * me claude — Claude Code integration commands.
 *
 * Two integration paths:
 *
 *   1. Full plugin (hooks + slash commands + MCP) via Claude Code's native
 *      plugin marketplace:
 *
 *        claude plugin marketplace add timescale/memory-engine
 *        claude plugin install memory-engine@memory-engine [--scope user|project|local]
 *        # then, in a Claude Code session:
 *        /plugin  # select memory-engine, Configure, fill space (+ optional api_key)
 *
 *      Claude Code delivers the configured values to our hook (`me claude
 *      hook --event <name>`) via CLAUDE_PLUGIN_OPTION_* env vars. api_key is
 *      optional: left blank, the hook (and the plugin's MCP server) use your
 *      `me login` session.
 *
 *   2. MCP-only via `me claude install`. Registers `me` as an MCP server
 *      with Claude Code (no hooks, no slash commands — just the tools).
 */
import { Command, InvalidArgumentError } from "commander";
import {
  HOOK_EVENT_NAMES,
  type HookEvent,
  type HookEventName,
  resolveHookConfigFromEnv,
  SESSIONS_NODE,
} from "../claude/capture.ts";
import { createMemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { claudeImporter } from "../importers/claude.ts";
import { importTranscriptFile } from "../importers/index.ts";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";
import { buildAgentImportSubcommand } from "./import.ts";

const CLAUDE_SCOPES = ["local", "user", "project"] as const;
type ClaudeScope = (typeof CLAUDE_SCOPES)[number];

function parseClaudeScope(value: string): ClaudeScope {
  if (!CLAUDE_SCOPES.includes(value as ClaudeScope)) {
    throw new InvalidArgumentError(
      `must be one of: ${CLAUDE_SCOPES.join(", ")}`,
    );
  }
  return value as ClaudeScope;
}

/**
 * me claude install — register me as an MCP server with Claude Code.
 *
 * MCP-only: leaves the full Claude Code plugin install flow alone. Use this
 * if you want the `me` MCP tools available in Claude Code but don't want the
 * plugin's hooks or slash commands.
 */
function createClaudeInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with Claude Code")
    .option(
      "--api-key <key>",
      "API key for a headless agent (default: use your login session at runtime)",
    )
    .option("--server <url>", "server URL to embed in MCP config")
    .option(
      "--space <slug>",
      "pin a space (default: resolve ME_SPACE / active space at runtime)",
    )
    .option(
      "-s, --scope <scope>",
      `Claude Code config scope (${CLAUDE_SCOPES.join(", ")})`,
      parseClaudeScope,
      "user",
    )
    .action(
      async (
        opts: AgentInstallOptions & { scope: ClaudeScope },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        await runAgentMcpInstall("claude", {
          apiKey: opts.apiKey,
          server: globalOpts.server ?? opts.server,
          space: opts.space,
          scope: opts.scope,
        });
      },
    );
}

/**
 * me claude hook — invoked by the Claude Code plugin on Stop / SessionEnd to
 * capture the session.
 *
 * Reads the event JSON from stdin for the `transcript_path`, resolves config
 * from the CLAUDE_PLUGIN_OPTION_* env vars (falling back to the `me login`
 * session when no api_key is configured), and runs the transcript through
 * `importTranscriptFile` — the same parse + write as `me import`, incremental so
 * each call only writes messages new since the last.
 *
 * Best-effort: logs failures to stderr but always exits 0 so that a hook
 * failure never blocks a Claude Code session.
 */
function createClaudeHookCommand(): Command {
  return new Command("hook")
    .description("invoked by Claude Code plugin hooks (reads event from stdin)")
    .requiredOption(
      "--event <name>",
      `hook event name (${HOOK_EVENT_NAMES.join(", ")})`,
    )
    .action(async (opts: { event: string }) => {
      const eventName = opts.event as HookEventName;
      if (!HOOK_EVENT_NAMES.includes(eventName)) {
        console.error(
          `[memory-engine] unknown event '${opts.event}'. Expected one of: ${HOOK_EVENT_NAMES.join(", ")}`,
        );
        process.exit(0);
      }

      // Resolve config: the plugin's api_key if configured, else fall back to
      // the user's `me login` session (resolved from the keychain/config).
      const config = resolveHookConfigFromEnv(
        process.env,
        resolveCredentials(),
      );
      if (!config) {
        console.error(
          "[memory-engine] no credentials. Run `me login`, or set the plugin's " +
            "api_key + space via `/plugin` in Claude Code.",
        );
        process.exit(0);
      }

      // Read + parse the event JSON from stdin for the transcript path.
      let event: HookEvent;
      try {
        event = JSON.parse(await Bun.stdin.text()) as HookEvent;
      } catch (error) {
        console.error(
          `[memory-engine] failed to read/parse event JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(0);
      }

      const transcriptPath = event.transcript_path;
      if (!transcriptPath) {
        console.error(
          `[memory-engine] ${eventName}: no transcript_path in event payload`,
        );
        process.exit(0);
      }

      // Import the transcript (incremental; same path as `me import`).
      try {
        const client = createMemoryClient({
          url: config.server,
          token: config.token,
          space: config.space,
        });
        await importTranscriptFile(client, claudeImporter, transcriptPath, {
          treeRoot: config.treeRoot,
          sessionsNodeName: SESSIONS_NODE,
          fullTranscript: config.fullTranscript,
          dryRun: false,
          verbose: false,
        });
      } catch (error) {
        console.error(
          `[memory-engine] ${eventName} capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      process.exit(0);
    });
}

export function createClaudeCommand(): Command {
  const claude = new Command("claude").description("Claude Code integration");
  claude.addCommand(createClaudeInstallCommand());
  claude.addCommand(createClaudeHookCommand());
  claude.addCommand(
    buildAgentImportSubcommand(
      "import Claude Code sessions from ~/.claude/projects",
      claudeImporter,
      true,
    ),
  );
  return claude;
}
