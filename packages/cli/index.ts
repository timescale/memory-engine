#!/usr/bin/env bun
/**
 * me — CLI for Memory Engine.
 *
 * Entry point: defines the root Commander program, registers global options
 * and all command groups, then runs.
 */
import { Command } from "commander";
import { createApiKeyCommand } from "./commands/apikey.ts";
import { createEngineCommand } from "./commands/engine.ts";
import { createGrantCommand } from "./commands/grant.ts";
import { createInvitationCommand } from "./commands/invitation.ts";
import { createLoginCommand } from "./commands/login.ts";
import { createLogoutCommand } from "./commands/logout.ts";
import { createMcpCommand } from "./commands/mcp.ts";
import { createMemoryCommand } from "./commands/memory.ts";
import { createOrgCommand } from "./commands/org.ts";
import { createOwnerCommand } from "./commands/owner.ts";
import { createRoleCommand } from "./commands/role.ts";
import { createUserCommand } from "./commands/user.ts";
import { createWhoamiCommand } from "./commands/whoami.ts";

const program = new Command();

program
  .name("me")
  .description("Memory Engine CLI")
  .version("0.1.0")
  .option(
    "--server <url>",
    "server URL (overrides ME_SERVER env and stored default)",
  )
  .option("--json", "output as JSON")
  .option("--yaml", "output as YAML");

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

// Engine-level RBAC commands
program.addCommand(createUserCommand());
program.addCommand(createGrantCommand());
program.addCommand(createRoleCommand());
program.addCommand(createOwnerCommand());
program.addCommand(createApiKeyCommand());

// Run
program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
