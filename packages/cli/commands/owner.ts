/**
 * me owner — tree ownership management commands.
 *
 * - me owner set <path> <user-id>: Set tree path owner
 * - me owner remove <path>: Remove tree path owner
 * - me owner get <path>: Get tree path owner
 * - me owner list [user-id]: List ownership records
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";

function createOwnerSetCommand(): Command {
  return new Command("set")
    .description("set tree path owner")
    .argument("<path>", "tree path")
    .argument("<user-id>", "user ID")
    .action(async (path: string, userId: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.owner.set({ userId, treePath: path });

        output(result, fmt, () => {
          clack.log.success(`Set owner of '${path}' to ${userId}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOwnerRemoveCommand(): Command {
  return new Command("remove")
    .description("remove tree path owner")
    .argument("<path>", "tree path")
    .action(async (path: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.owner.remove({ treePath: path });

        output(result, fmt, () => {
          if (result.removed) {
            clack.log.success(`Removed owner of '${path}'`);
          } else {
            clack.log.warn(`No owner found for '${path}'`);
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOwnerGetCommand(): Command {
  return new Command("get")
    .description("get tree path owner")
    .argument("<path>", "tree path")
    .action(async (path: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const owner = await engine.owner.get({ treePath: path });

        output(owner, fmt, () => {
          console.log(`  Path:      ${owner.treePath}`);
          console.log(`  Owner:     ${owner.userId}`);
          console.log(`  Set by:    ${owner.createdBy ?? "(unknown)"}`);
          console.log(`  Created:   ${owner.createdAt}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOwnerListCommand(): Command {
  return new Command("list")
    .description("list ownership records")
    .argument("[user-id]", "filter by user ID (optional)")
    .action(async (userId: string | undefined, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const { owners } = await engine.owner.list(
          userId ? { userId } : undefined,
        );

        output({ owners }, fmt, () => {
          if (owners.length === 0) {
            console.log("  No ownership records found.");
            return;
          }
          for (const o of owners) {
            console.log(`  ${o.treePath.padEnd(30)} ${o.userId}`);
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

export function createOwnerCommand(): Command {
  const owner = new Command("owner").description("manage tree ownership");
  owner.addCommand(createOwnerSetCommand());
  owner.addCommand(createOwnerRemoveCommand());
  owner.addCommand(createOwnerGetCommand());
  owner.addCommand(createOwnerListCommand());
  return owner;
}
