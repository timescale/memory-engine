/**
 * me gemini — Gemini CLI integration commands.
 *
 * - me gemini install: register me as an MCP server with Gemini CLI, and
 *   (as of HARNESS_DESIGN.md PR 2) wire the harness-injected shell contract
 *   via a user-scope BeforeTool hook.
 * - me gemini env-hook: invoked by that hook to rewrite shell commands.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command, InvalidArgumentError } from "commander";
import { ensureDefaultAgent } from "../agent/default-agent.ts";
import { resolveCredentials } from "../credentials.ts";
import { buildGeminiEnvHookOutput } from "../gemini/env-hook.ts";
import {
  type JsonHookEntry,
  upsertJsonHooksFile,
} from "../harness-hooks-json.ts";
import { logUnrecognizedPayloadShape } from "../harness-shape-log.ts";
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

/** The hook command Gemini invokes — bare, no version string. */
const GEMINI_ENV_HOOK_COMMAND = "me gemini env-hook";

/** Our canonical BeforeTool hook definition — kept as one literal so every
 * install writes byte-identical JSON. */
const GEMINI_HOOK_ENTRY: JsonHookEntry = {
  matcher: "run_shell_command",
  hooks: [{ type: "command", command: GEMINI_ENV_HOOK_COMMAND }],
};

/** Write (or refresh) the user-scope `~/.gemini/settings.json` BeforeTool entry. */
function installGeminiEnvHook(): void {
  const path = join(homedir(), ".gemini", "settings.json");
  const { changed } = upsertJsonHooksFile(
    path,
    "BeforeTool",
    GEMINI_HOOK_ENTRY,
    GEMINI_ENV_HOOK_COMMAND,
  );
  if (changed) {
    clack.log.success(`Installed the Gemini CLI BeforeTool hook → ${path}`);
  }
}

function createGeminiInstallCommand(): Command {
  return new Command("install")
    .description("register me as an MCP server with Gemini CLI")
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
      `Gemini CLI config scope (${GEMINI_SCOPES.join(", ")})`,
      parseGeminiScope,
      "user",
    )
    .option(
      "--no-default-agent",
      "skip provisioning a default agent (agent: coder) for this install",
    )
    .action(
      async (
        opts: AgentInstallOptions & {
          scope: GeminiScope;
          defaultAgent?: boolean;
        },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        const server = globalOpts.server ?? opts.server;
        await runAgentMcpInstall("gemini", {
          apiKey: opts.apiKey,
          server,
          space: opts.space,
          scope: opts.scope,
        });

        installGeminiEnvHook();

        const creds = resolveCredentials(server);
        const headless = Boolean(opts.apiKey ?? creds.apiKey);
        if (!headless && opts.defaultAgent !== false) {
          await ensureDefaultAgent({
            ...creds,
            activeSpace: opts.space ?? creds.activeSpace,
          });
        }
      },
    );
}

/**
 * me gemini env-hook — invoked by the BeforeTool hook installed above.
 * Structural twin of `me codex env-hook`: reads the payload from stdin, and
 * for a `run_shell_command` call prints a rewrite that prepends the harness
 * contract's `export …; ` prefix. Fails open (empty stdout) on anything it
 * doesn't recognize, logging the shape (never command content). Always
 * exits 0.
 */
function createGeminiEnvHookCommand(): Command {
  return new Command("env-hook")
    .description(
      "invoked by Gemini CLI's BeforeTool hook to inject the harness contract into shell commands",
    )
    .action(async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(await Bun.stdin.text());
      } catch {
        logUnrecognizedPayloadShape("gemini", undefined);
        process.exit(0);
      }

      const result = buildGeminiEnvHookOutput(payload, process.env);
      if (result.unrecognizedShape) {
        logUnrecognizedPayloadShape("gemini", payload);
      }
      if (result.output) {
        console.log(JSON.stringify(result.output));
      }
      process.exit(0);
    });
}

export function createGeminiCommand(): Command {
  const gemini = new Command("gemini").description("Gemini CLI integration");
  gemini.addCommand(createGeminiInstallCommand());
  gemini.addCommand(createGeminiEnvHookCommand());
  return gemini;
}
