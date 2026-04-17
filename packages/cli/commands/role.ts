/**
 * me role — role management commands.
 *
 * - me role create <name>: Create a role
 * - me role list: List all roles
 * - me role add-member <role> <member>: Add user to role (by ID or name)
 * - me role remove-member <role> <member>: Remove user from role (by ID or name)
 * - me role members <role>: List role members (by ID or name)
 * - me role list-for <user>: List roles a user belongs to (by ID or name)
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

function createRoleCreateCommand(): Command {
  return new Command("create")
    .description("create a role")
    .argument("<name>", "role name")
    .option("--identity-id <id>", "link to an accounts identity")
    .action(async (name: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const role = await engine.role.create({
          name,
          identityId: opts.identityId ?? undefined,
        });

        output(role, fmt, () => {
          clack.log.success(`Created role '${role.name}'`);
          console.log(`  ID: ${role.id}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createRoleListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list all roles")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        // Roles are users with canLogin=false
        const { users: roles } = await engine.user.list({ canLogin: false });

        output({ roles }, fmt, () => {
          if (roles.length === 0) {
            console.log("  No roles found.");
            return;
          }
          table(
            ["id", "name"],
            roles.map((r) => [r.id, r.name]),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createRoleAddMemberCommand(): Command {
  return new Command("add-member")
    .description("add a user to a role")
    .argument("<role>", "role ID or name")
    .argument("<member>", "member ID or name")
    .option("--with-admin-option", "allow member to manage this role")
    .action(async (role: string, member: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const [roleId, memberId] = await Promise.all([
          resolveUserId(engine, role),
          resolveUserId(engine, member),
        ]);

        const result = await engine.role.addMember({
          roleId,
          memberId,
          withAdminOption: opts.withAdminOption ?? false,
        });

        output(result, fmt, () => {
          if (result.added) {
            clack.log.success(`Added ${member} to role ${role}`);
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createRoleRemoveMemberCommand(): Command {
  return new Command("remove-member")
    .description("remove a user from a role")
    .argument("<role>", "role ID or name")
    .argument("<member>", "member ID or name")
    .action(async (role: string, member: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const [roleId, memberId] = await Promise.all([
          resolveUserId(engine, role),
          resolveUserId(engine, member),
        ]);

        const result = await engine.role.removeMember({ roleId, memberId });

        output(result, fmt, () => {
          if (result.removed) {
            clack.log.success(`Removed ${member} from role ${role}`);
          } else {
            clack.log.warn("Membership not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createRoleMembersCommand(): Command {
  return new Command("members")
    .description("list members of a role")
    .argument("<role>", "role ID or name")
    .action(async (role: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const roleId = await resolveUserId(engine, role);
        const { members } = await engine.role.listMembers({ roleId });

        output({ members }, fmt, () => {
          if (members.length === 0) {
            console.log("  No members found.");
            return;
          }
          table(
            ["member_id", "name", "admin"],
            members.map((m) => [
              m.memberId,
              m.memberName,
              m.withAdminOption ? "yes" : "",
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createRoleListForCommand(): Command {
  return new Command("list-for")
    .description("list roles a user belongs to")
    .argument("<user>", "user ID or name")
    .action(async (user: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const userId = await resolveUserId(engine, user);
        const { roles } = await engine.role.listForUser({ userId });

        output({ roles }, fmt, () => {
          if (roles.length === 0) {
            console.log("  No roles found.");
            return;
          }
          table(
            ["id", "name", "admin"],
            roles.map((r) => [r.id, r.name, r.withAdminOption ? "yes" : ""]),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

export function createRoleCommand(): Command {
  const role = new Command("role").description("manage roles");
  role.addCommand(createRoleCreateCommand());
  role.addCommand(createRoleListCommand());
  role.addCommand(createRoleAddMemberCommand());
  role.addCommand(createRoleRemoveMemberCommand());
  role.addCommand(createRoleMembersCommand());
  role.addCommand(createRoleListForCommand());
  return role;
}
