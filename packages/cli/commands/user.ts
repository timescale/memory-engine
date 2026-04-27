/**
 * me user — engine user management commands.
 *
 * - me user list: List users in the active engine
 * - me user create <name>: Create an engine user
 * - me user get <id-or-name>: Get user by ID or name
 * - me user delete <id-or-name>: Delete a user (by ID or name)
 * - me user rename <id-or-name> <new-name>: Rename a user (by ID or name)
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { createClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import {
  handleError,
  requireEngine,
  requireSession,
  resolveUserId,
} from "../util.ts";

function createUserListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list users in the active engine")
    .option("--login-only", "only show users that can login")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const { users } = await engine.user.list(
          opts.loginOnly ? { canLogin: true } : undefined,
        );

        output({ users }, fmt, () => {
          if (users.length === 0) {
            console.log("  No users found.");
            return;
          }
          table(
            ["id", "name", "flags"],
            users.map((u) => {
              const flags = [
                u.superuser ? "superuser" : "",
                u.createrole ? "createrole" : "",
                !u.canLogin ? "role" : "",
              ]
                .filter(Boolean)
                .join(", ");
              return [u.id, u.name, flags];
            }),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createUserCreateCommand(): Command {
  return new Command("create")
    .description("create an engine user")
    .argument("<name>", "user name")
    .option("--superuser", "grant superuser privileges")
    .option("--createrole", "can create other users/roles")
    .option("--no-login", "create as role (cannot authenticate)")
    .option("--identity-id <id>", "link to an accounts identity")
    .action(async (name: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const user = await engine.user.create({
          name,
          superuser: opts.superuser ?? false,
          createrole: opts.createrole ?? false,
          canLogin: opts.login !== false,
          identityId: opts.identityId ?? undefined,
        });

        output(user, fmt, () => {
          clack.log.success(`Created user '${user.name}'`);
          console.log(`  ID:        ${user.id}`);
          console.log(`  Superuser: ${user.superuser}`);
          console.log(`  Can Login: ${user.canLogin}`);
          if (user.identityId) {
            console.log(`  Identity:  ${user.identityId}`);
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createUserGetCommand(): Command {
  return new Command("get")
    .description("get a user by ID or name")
    .argument("<id-or-name>", "user ID (UUIDv7) or name")
    .action(async (idOrName: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const id = await resolveUserId(engine, idOrName);
        const user = await engine.user.get({ id });

        output(user, fmt, () => {
          console.log(`  Name:       ${user.name}`);
          console.log(`  ID:         ${user.id}`);
          console.log(`  Superuser:  ${user.superuser}`);
          console.log(`  Createrole: ${user.createrole}`);
          console.log(`  Can Login:  ${user.canLogin}`);
          console.log(`  Identity:   ${user.identityId ?? "(none)"}`);
          console.log(`  Created:    ${user.createdAt}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createUserDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description("delete a user")
    .argument("<id-or-name>", "user ID or name")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (idOrName: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      if (fmt === "text" && !opts.yes) {
        const confirmed = await clack.confirm({
          message: `Delete user ${idOrName}? This cannot be undone.`,
        });
        if (clack.isCancel(confirmed) || !confirmed) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
      }

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const id = await resolveUserId(engine, idOrName);
        const result = await engine.user.delete({ id });

        output(result, fmt, () => {
          if (result.deleted) {
            clack.log.success("User deleted.");
          } else {
            clack.log.warn("User not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createUserRenameCommand(): Command {
  return new Command("rename")
    .description("rename a user")
    .argument("<id-or-name>", "user ID or name")
    .argument("<new-name>", "new name")
    .action(async (idOrName: string, newName: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const id = await resolveUserId(engine, idOrName);
        const result = await engine.user.rename({ id, name: newName });

        output(result, fmt, () => {
          if (result.renamed) {
            clack.log.success(`User renamed to '${newName}'.`);
          } else {
            clack.log.warn("User not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

export function createUserCommand(): Command {
  const user = new Command("user").description("manage engine users");
  user.addCommand(createUserListCommand());
  user.addCommand(createUserCreateCommand());
  user.addCommand(createUserGetCommand());
  user.addCommand(createUserDeleteCommand());
  user.addCommand(createUserRenameCommand());
  return user;
}
