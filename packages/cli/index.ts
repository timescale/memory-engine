#!/usr/bin/env bun
import t from "@bomb.sh/tab";
import createTabFromCommander from "@bomb.sh/tab/commander";
import { Command } from "commander";
/**
 * me — CLI for Memory Engine.
 *
 * Entry point: defines the root Commander program, registers global options
 * and all command groups, then runs.
 */
import { CLIENT_VERSION } from "../../version";
import { createAccessCommand } from "./commands/access.ts";
import { createAgentCommand } from "./commands/agent.ts";
import { createApiKeyCommand } from "./commands/apikey.ts";
import { createClaudeCommand } from "./commands/claude.ts";
import { createCodexCommand } from "./commands/codex.ts";
import { createGeminiCommand } from "./commands/gemini.ts";
import { createGroupCommand } from "./commands/group.ts";
import { createImportCommand } from "./commands/import-group.ts";
import { createInviteCommand } from "./commands/invite.ts";
import { createLoginCommand } from "./commands/login.ts";
import { createLogoutCommand } from "./commands/logout.ts";
import { createMcpCommand } from "./commands/mcp.ts";
import {
  createMemoryAliasCommands,
  createMemoryCommand,
} from "./commands/memory.ts";
import { createOpenCodeCommand } from "./commands/opencode.ts";
import { createPackCommand } from "./commands/pack.ts";
import {
  createProjectCommand,
  createRemovedCommand,
} from "./commands/project.ts";
import { createServeCommand } from "./commands/serve.ts";
import { createSpaceCommand } from "./commands/space.ts";
import { createStatusCommand } from "./commands/status.ts";
import { createUpgradeCommand } from "./commands/upgrade.ts";
import { createVersionCommand } from "./commands/version.ts";
import { createWhoamiCommand } from "./commands/whoami.ts";
import {
  isAsAgentRequested,
  resolveCredentials,
  setAsAgentOverride,
  setServerFlagOverride,
} from "./credentials.ts";
import { checkHarnessFailsafe } from "./failsafe.ts";
import { setExpanded } from "./output.ts";
import {
  setConfigDirOverride,
  setProjectDirOverride,
} from "./project-config.ts";
import { buildUserClient } from "./util.ts";

const SHELLS = ["zsh", "bash", "fish", "powershell"] as const;
type Shell = (typeof SHELLS)[number];

const program = new Command();

program
  .name("me")
  .description("Memory Engine CLI")
  .version(CLIENT_VERSION)
  .option(
    "--server <url>",
    "server URL (overrides ME_SERVER env and stored default)",
  )
  .option(
    "--config-dir <dir>",
    "directory containing the .me/config.yaml to use (else walk up from cwd; ME_CONFIG_DIR)",
  )
  .option(
    "--project-dir <dir>",
    "anchor to walk up from when discovering .me/ (replaces cwd; ME_PROJECT_DIR — set by harness adapters, rarely passed by hand)",
  )
  .option(
    "--as-agent <idOrName>",
    "act as one of your own agents (id/name, or '.me' for the .me/config.yaml agent); overrides ME_AS_AGENT",
  )
  .option("--json", "output as JSON")
  .option("--yaml", "output as YAML")
  .option("-x, --expanded", "show list output in expanded (vertical) format");

/** The space-joined command path below the root program, e.g. "claude hook". */
function commandPathOf(actionCommand: Command, root: Command): string {
  const parts: string[] = [];
  let cur: Command | null = actionCommand;
  while (cur && cur !== root) {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  return parts.join(" ");
}

// Set expanded mode + seed the .me/config.yaml resolver before any command
// runs, then run the harness shell failsafe (see failsafe.ts).
program.hook("preAction", async (thisCommand, actionCommand) => {
  const opts = thisCommand.optsWithGlobals();
  setExpanded(opts.expanded ?? false);
  setConfigDirOverride(
    typeof opts.configDir === "string" ? opts.configDir : undefined,
  );
  setProjectDirOverride(
    typeof opts.projectDir === "string" ? opts.projectDir : undefined,
  );
  setAsAgentOverride(
    typeof opts.asAgent === "string" ? opts.asAgent : undefined,
  );
  setServerFlagOverride(
    typeof opts.server === "string" ? opts.server : undefined,
  );

  const verdict = await checkHarnessFailsafe(
    {
      commandPath: commandPathOf(actionCommand, thisCommand),
      env: process.env,
      hasExplicitAsAgent: isAsAgentRequested(),
      hasApiKeyClaim: Boolean(process.env.ME_API_KEY),
      isStderrTTY: Boolean(process.stderr.isTTY),
    },
    async () => {
      const apiKey = process.env.ME_API_KEY;
      if (!apiKey) return false;
      const identity = await buildUserClient({
        ...resolveCredentials(),
        apiKey,
      }).whoami();
      return identity.kind === "a";
    },
  );
  if (verdict.action === "notice") {
    console.error(verdict.message);
  } else if (verdict.action === "error") {
    console.error(verdict.message);
    process.exit(1);
  }
});

// Auth commands
program.addCommand(createLoginCommand());
program.addCommand(createLogoutCommand());
program.addCommand(createWhoamiCommand());
program.addCommand(createStatusCommand());

// Version + compatibility check
program.addCommand(createVersionCommand());
program.addCommand(createUpgradeCommand());

// Space commands (the new model: spaces, groups, access, agents, api keys)
program.addCommand(createSpaceCommand());
program.addCommand(createInviteCommand());
program.addCommand(createGroupCommand());
program.addCommand(createAccessCommand());
program.addCommand(createAgentCommand());
program.addCommand(createApiKeyCommand());

// Memory commands — both as `me memory <cmd>` and top-level aliases (`me search`)
program.addCommand(createMemoryCommand());
for (const c of createMemoryAliasCommands()) program.addCommand(c);

// Import group — one subcommand per source (`me import memories|claude|codex|opencode|git`)
program.addCommand(createImportCommand());

// MCP server
program.addCommand(createMcpCommand());

// Agent integration commands (install MCP, import sessions, capture hooks)
const claude = createClaudeCommand();
// `me claude init` is retired — redirect to `me project init` (registered
// here so claude.ts and project.ts don't cycle).
claude.addCommand(createRemovedCommand("me claude init"));
program.addCommand(claude);
const opencode = createOpenCodeCommand();
// `me opencode init` is retired — redirect to `me project init`, mirroring
// the claude alias above.
opencode.addCommand(createRemovedCommand("me opencode init"));
program.addCommand(opencode);
program.addCommand(createGeminiCommand());
program.addCommand(createCodexCommand());

// Harness-agnostic per-project setup (`me project init`)
program.addCommand(createProjectCommand());

// Local web UI
program.addCommand(createServeCommand());

// Pack commands
program.addCommand(createPackCommand());

// Shell completions (visible command)
program
  .command("completions")
  .description("set up shell completions")
  .argument("[shell]", `shell type (${SHELLS.join(", ")})`)
  .action((shell?: string) => {
    if (!shell) {
      console.log(`Available shells: ${SHELLS.join(", ")}`);
      console.log("\nRun: me completions <shell>");
      return;
    }
    if (!SHELLS.includes(shell as Shell)) {
      console.error(`Unknown shell: ${shell}`);
      console.error(`Available: ${SHELLS.join(", ")}`);
      process.exit(1);
    }
    console.log("# Add to your shell config:");
    if (shell === "fish") {
      console.log("me complete fish | source");
    } else if (shell === "powershell") {
      console.log("me complete powershell | Out-String | Invoke-Expression");
    } else {
      console.log(`source <(me complete ${shell})`);
    }
  });

// =============================================================================
// Shell completion fast path (before parseAsync)
// =============================================================================

// Handle `me complete <shell>` and `me complete -- <args...>` before
// Commander parses, so tab completion is fast.
if (process.argv[2] === "complete") {
  createTabFromCommander(program);

  const shell = process.argv[3];
  if (shell === "--") {
    // Parse completion request (called by shell during tab completion)
    const args = process.argv.slice(4);
    t.parse(args);
  } else if (shell && SHELLS.includes(shell as Shell)) {
    // Generate shell completion script
    t.setup("me", "me", shell);
  } else {
    console.error(`Usage: me complete <${SHELLS.join("|")}>`);
    console.error("       me complete -- <args...>");
    process.exit(1);
  }
  process.exit(0);
}

// =============================================================================
// Run
// =============================================================================

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
