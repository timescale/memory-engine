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
import { createApiKeyCommand } from "./commands/apikey.ts";
import { createClaudeCommand } from "./commands/claude.ts";
import { createCodexCommand } from "./commands/codex.ts";
import { createEngineCommand } from "./commands/engine.ts";
import { createGeminiCommand } from "./commands/gemini.ts";
import { createGrantCommand } from "./commands/grant.ts";
import { createInvitationCommand } from "./commands/invitation.ts";
import { createLoginCommand } from "./commands/login.ts";
import { createLogoutCommand } from "./commands/logout.ts";
import { createMcpCommand } from "./commands/mcp.ts";
import { createMemoryCommand } from "./commands/memory.ts";
import { createOpenCodeCommand } from "./commands/opencode.ts";
import { createOrgCommand } from "./commands/org.ts";
import { createOwnerCommand } from "./commands/owner.ts";
import { createPackCommand } from "./commands/pack.ts";
import { createRoleCommand } from "./commands/role.ts";
import { createUserCommand } from "./commands/user.ts";
import { createWhoamiCommand } from "./commands/whoami.ts";
import { setExpanded } from "./output.ts";

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
  .option("--json", "output as JSON")
  .option("--yaml", "output as YAML")
  .option("-x, --expanded", "show list output in expanded (vertical) format");

// Set expanded mode before any command runs
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  setExpanded(opts.expanded ?? false);
});

// Auth commands
program.addCommand(createLoginCommand());
program.addCommand(createLogoutCommand());
program.addCommand(createWhoamiCommand());

// Engine commands
program.addCommand(createEngineCommand());

// Org commands
program.addCommand(createOrgCommand());

// Invitation commands
program.addCommand(createInvitationCommand());

// Memory commands
program.addCommand(createMemoryCommand());

// MCP server
program.addCommand(createMcpCommand());

// Agent integration commands (install MCP, import sessions, capture hooks)
program.addCommand(createClaudeCommand());
program.addCommand(createOpenCodeCommand());
program.addCommand(createGeminiCommand());
program.addCommand(createCodexCommand());

// Engine-level RBAC commands
program.addCommand(createUserCommand());
program.addCommand(createGrantCommand());
program.addCommand(createRoleCommand());
program.addCommand(createOwnerCommand());
program.addCommand(createApiKeyCommand());

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
