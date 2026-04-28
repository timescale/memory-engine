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
 *        /plugin  # select memory-engine, Configure, fill api_key/server/tree_prefix
 *
 *      Claude Code delivers the configured values to our hook (`me claude
 *      hook --event <name>`) via CLAUDE_PLUGIN_OPTION_* env vars.
 *
 *   2. MCP-only via `me claude install`. Registers `me` as an MCP server
 *      with Claude Code (no hooks, no slash commands — just the tools).
 */
import { Command, InvalidArgumentError } from "commander";
import {
  captureHookEvent,
  HOOK_EVENT_NAMES,
  type HookEvent,
  type HookEventName,
  resolveHookConfigFromEnv,
} from "../claude/capture.ts";
import { claudeImporter } from "../importers/claude.ts";
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
    .option("--api-key <key>", "API key to embed in MCP config")
    .option("--server <url>", "server URL to embed in MCP config")
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
          scope: opts.scope,
        });
      },
    );
}

/**
 * me claude hook — invoked by the Claude Code plugin to capture events as
 * memories.
 *
 * Reads the event JSON from stdin, pulls credentials + config from the
 * CLAUDE_PLUGIN_OPTION_* env vars that Claude Code exports for the plugin,
 * and creates a memory.
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

      // Resolve config from env
      const config = resolveHookConfigFromEnv();
      if (!config) {
        console.error(
          "[memory-engine] CLAUDE_PLUGIN_OPTION_API_KEY not set. " +
            "Configure the plugin via `/plugin` in Claude Code.",
        );
        process.exit(0);
      }

      // Read stdin
      let input: string;
      try {
        input = await Bun.stdin.text();
      } catch (error) {
        console.error(
          `[memory-engine] failed to read stdin: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(0);
      }

      // Parse JSON
      let event: HookEvent;
      try {
        event = JSON.parse(input) as HookEvent;
      } catch (error) {
        console.error(
          `[memory-engine] failed to parse event JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(0);
      }

      // Capture
      try {
        const result = await captureHookEvent(event, eventName, config);
        if (result.status === "skipped") {
          // Silent skip — no stderr output for empty content
          process.exit(0);
        }
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
