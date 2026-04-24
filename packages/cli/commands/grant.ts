/**
 * me grant — tree grant management commands.
 *
 * - me grant create <user> <path> <actions...>: Grant tree access
 * - me grant revoke <user> <path>: Revoke tree access
 * - me grant list [user]: List grants
 * - me grant check <user> <path> <action>: Check access
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory.build/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import {
  handleError,
  requireEngine,
  requireSession,
  resolveUserId,
} from "../util.ts";

function createGrantCreateCommand(): Command {
  return new Command("create")
    .description("grant tree access to a user")
    .argument("<user>", "user name or ID")
    .argument("<path>", "tree path")
    .argument("<actions...>", "actions: read, create, update, delete")
    .option("--with-grant-option", "allow grantee to re-grant")
    .action(
      async (user: string, path: string, actions: string[], opts, cmd) => {
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
          const userId = await resolveUserId(engine, user);
          const result = await engine.grant.create({
            userId,
            treePath: path,
            actions: actions as ("read" | "create" | "update" | "delete")[],
            withGrantOption: opts.withGrantOption ?? false,
          });

          output(result, fmt, () => {
            clack.log.success(
              `Granted [${actions.join(", ")}] on '${path}' to ${user}`,
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
    .argument("<user>", "user name or ID")
    .argument("<path>", "tree path")
    .action(async (user: string, path: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const userId = await resolveUserId(engine, user);
        const result = await engine.grant.revoke({
          userId,
          treePath: path,
        });

        output(result, fmt, () => {
          if (result.revoked) {
            clack.log.success(`Revoked grant on '${path}' from ${user}`);
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
    .alias("ls")
    .description("list grants")
    .argument("[user]", "filter by user name or ID (optional)")
    .action(async (user: string | undefined, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const userId = user ? await resolveUserId(engine, user) : undefined;
        const { grants } = await engine.grant.list(
          userId ? { userId } : undefined,
        );

        output({ grants }, fmt, () => {
          if (grants.length === 0) {
            console.log("  No grants found.");
            return;
          }
          table(
            ["user", "tree_path", "actions", "grant_option"],
            grants.map((g) => [
              g.userName,
              g.treePath,
              g.actions.join(", "),
              g.withGrantOption ? "yes" : "",
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createGrantCheckCommand(): Command {
  return new Command("check")
    .description("check if a user has access to a tree path")
    .argument("<user>", "user name or ID")
    .argument("<path>", "tree path")
    .argument("<action>", "action: read, create, update, delete")
    .action(async (user: string, path: string, action: string, _opts, cmd) => {
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
        const userId = await resolveUserId(engine, user);
        const result = await engine.grant.check({
          userId,
          treePath: path,
          action: action as "read" | "create" | "update" | "delete",
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
    });
}

export function createGrantCommand(): Command {
  const grant = new Command("grant").description("manage tree grants");
  grant.addCommand(createGrantCreateCommand());
  grant.addCommand(createGrantRevokeCommand());
  grant.addCommand(createGrantListCommand());
  grant.addCommand(createGrantCheckCommand());
  return grant;
}
