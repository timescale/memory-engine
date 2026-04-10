/**
 * me grant — tree grant management commands.
 *
 * - me grant create <user-id> <path> <actions...>: Grant tree access
 * - me grant revoke <user-id> <path>: Revoke tree access
 * - me grant list [user-id]: List grants
 * - me grant check <user-id> <path> <action>: Check access
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";

function createGrantCreateCommand(): Command {
  return new Command("create")
    .description("grant tree access to a user")
    .argument("<user-id>", "user ID")
    .argument("<path>", "tree path")
    .argument("<actions...>", "actions: read, write, create, delete, admin")
    .option("--with-grant-option", "allow grantee to re-grant")
    .action(
      async (userId: string, path: string, actions: string[], opts, cmd) => {
        const globalOpts = cmd.optsWithGlobals();
        const creds = resolveCredentials(globalOpts.server);
        const fmt = getOutputFormat(globalOpts);
        requireSession(creds, fmt);
        requireEngine(creds, fmt);

        const engine = createClient({
          url: creds.server,
          apiKey: creds.apiKey,
        });

        try {
          const result = await engine.grant.create({
            userId,
            treePath: path,
            actions: actions as ("read" | "write" | "delete" | "admin")[],
            withGrantOption: opts.withGrantOption ?? false,
          });

          output(result, fmt, () => {
            clack.log.success(
              `Granted [${actions.join(", ")}] on '${path}' to ${userId}`,
            );
          });
        } catch (error) {
          handleError(error, fmt);
        }
      },
    );
}

function createGrantRevokeCommand(): Command {
  return new Command("revoke")
    .description("revoke tree access from a user")
    .argument("<user-id>", "user ID")
    .argument("<path>", "tree path")
    .action(async (userId: string, path: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.grant.revoke({
          userId,
          treePath: path,
        });

        output(result, fmt, () => {
          if (result.revoked) {
            clack.log.success(`Revoked grant on '${path}' from ${userId}`);
          } else {
            clack.log.warn("Grant not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createGrantListCommand(): Command {
  return new Command("list")
    .description("list grants")
    .argument("[user-id]", "filter by user ID (optional)")
    .action(async (userId: string | undefined, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const { grants } = await engine.grant.list(
          userId ? { userId } : undefined,
        );

        output({ grants }, fmt, () => {
          if (grants.length === 0) {
            console.log("  No grants found.");
            return;
          }
          for (const g of grants) {
            const grantOpt = g.withGrantOption ? " [grant option]" : "";
            console.log(
              `  ${g.userId}  ${g.treePath.padEnd(25)} [${g.actions.join(", ")}]${grantOpt}`,
            );
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createGrantCheckCommand(): Command {
  return new Command("check")
    .description("check if a user has access to a tree path")
    .argument("<user-id>", "user ID")
    .argument("<path>", "tree path")
    .argument("<action>", "action: read, write, create, delete, admin")
    .action(
      async (userId: string, path: string, action: string, _opts, cmd) => {
        const globalOpts = cmd.optsWithGlobals();
        const creds = resolveCredentials(globalOpts.server);
        const fmt = getOutputFormat(globalOpts);
        requireSession(creds, fmt);
        requireEngine(creds, fmt);

        const engine = createClient({
          url: creds.server,
          apiKey: creds.apiKey,
        });

        try {
          const result = await engine.grant.check({
            userId,
            treePath: path,
            action: action as "read" | "write" | "delete" | "admin",
          });

          output(result, fmt, () => {
            if (result.allowed) {
              clack.log.success(`${action} on '${path}': allowed`);
            } else {
              clack.log.warn(`${action} on '${path}': denied`);
            }
          });
        } catch (error) {
          handleError(error, fmt);
        }
      },
    );
}

export function createGrantCommand(): Command {
  const grant = new Command("grant").description("manage tree grants");
  grant.addCommand(createGrantCreateCommand());
  grant.addCommand(createGrantRevokeCommand());
  grant.addCommand(createGrantListCommand());
  grant.addCommand(createGrantCheckCommand());
  return grant;
}
