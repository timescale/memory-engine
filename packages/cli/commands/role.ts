/**
 * me role — role management commands.
 *
 * - me role create <name>: Create a role
 * - me role list: List all roles
 * - me role add-member <role-id> <member-id>: Add user to role
 * - me role remove-member <role-id> <member-id>: Remove user from role
 * - me role members <role-id>: List role members
 * - me role list-for <user-id>: List roles a user belongs to
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";

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
          for (const r of roles) {
            console.log(`  ${r.name.padEnd(20)} ${r.id}`);
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createRoleAddMemberCommand(): Command {
  return new Command("add-member")
    .description("add a user to a role")
    .argument("<role-id>", "role ID")
    .argument("<member-id>", "member (user) ID")
    .option("--with-admin-option", "allow member to manage this role")
    .action(async (roleId: string, memberId: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.role.addMember({
          roleId,
          memberId,
          withAdminOption: opts.withAdminOption ?? false,
        });

        output(result, fmt, () => {
          if (result.added) {
            clack.log.success(`Added ${memberId} to role ${roleId}`);
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
    .argument("<role-id>", "role ID")
    .argument("<member-id>", "member (user) ID")
    .action(async (roleId: string, memberId: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.role.removeMember({ roleId, memberId });

        output(result, fmt, () => {
          if (result.removed) {
            clack.log.success(`Removed ${memberId} from role ${roleId}`);
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
    .argument("<role-id>", "role ID")
    .action(async (roleId: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const { members } = await engine.role.listMembers({ roleId });

        output({ members }, fmt, () => {
          if (members.length === 0) {
            console.log("  No members found.");
            return;
          }
          for (const m of members) {
            const admin = m.withAdminOption ? " [admin]" : "";
            console.log(`  ${m.memberId}${admin}`);
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createRoleListForCommand(): Command {
  return new Command("list-for")
    .description("list roles a user belongs to")
    .argument("<user-id>", "user ID")
    .action(async (userId: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const { roles } = await engine.role.listForUser({ userId });

        output({ roles }, fmt, () => {
          if (roles.length === 0) {
            console.log("  No roles found.");
            return;
          }
          for (const r of roles) {
            const admin = r.withAdminOption ? " [admin]" : "";
            console.log(`  ${r.name.padEnd(20)} ${r.id}${admin}`);
          }
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
