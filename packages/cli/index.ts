#!/usr/bin/env bun
/**
 * me — CLI for Memory Engine.
 *
 * Entry point: defines the root Commander program, registers global options
 * and all command groups, then runs.
 */
import { Command } from "commander";
import { createLoginCommand } from "./commands/login.ts";
import { createLogoutCommand } from "./commands/logout.ts";
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

// Run
program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
