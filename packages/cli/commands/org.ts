/**
 * me org — organization management commands.
 *
 * - me org list: List your organizations
 * - me org create <name>: Create an organization
 * - me org delete <name-or-id>: Delete an organization
 * - me org member list [org]: List members
 * - me org member add <email-or-id> <role>: Add a member
 * - me org member remove <name-email-or-id>: Remove a member
 */
import * as clack from "@clack/prompts";
import { createAccountsClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import {
  handleError,
  requireSession,
  resolveIdentityId,
  resolveMember,
  resolveOrg,
  resolveOrgId,
} from "../util.ts";

// =============================================================================
// Org Commands
// =============================================================================

function createOrgListCommand(): Command {
  return new Command("list")
    .description("list your organizations")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const { orgs } = await accounts.org.list();

        output({ orgs }, fmt, () => {
          if (orgs.length === 0) {
            console.log("  No organizations found.");
            return;
          }
          table(
            ["id", "name", "slug"],
            orgs.map((org) => [org.id, org.name, org.slug]),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOrgCreateCommand(): Command {
  return new Command("create")
    .description("create an organization")
    .argument("<name>", "organization name")
    .action(async (name: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const org = await accounts.org.create({ name });

        output(org, fmt, () => {
          clack.log.success(`Created organization '${org.name}'`);
          console.log(`  ID:   ${org.id}`);
          console.log(`  Slug: ${org.slug}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOrgDeleteCommand(): Command {
  return new Command("delete")
    .description("delete an organization")
    .argument("<name-or-id>", "organization name, slug, or ID")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (nameOrId: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const org = await resolveOrg(accounts, fmt, undefined, nameOrId);

        // Confirm in text mode unless --yes
        if (fmt === "text" && !opts.yes) {
          const confirmed = await clack.confirm({
            message: `Delete organization '${org.name}'? This cannot be undone.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }

        const result = await accounts.org.delete({ id: org.id });

        output(result, fmt, () => {
          if (result.deleted) {
            clack.log.success(`Organization '${org.name}' deleted.`);
          } else {
            clack.log.warn("Organization not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

// =============================================================================
// Org Member Commands
// =============================================================================

function createOrgMemberListCommand(): Command {
  return new Command("list")
    .description("list organization members")
    .argument("[org]", "organization name, slug, or ID")
    .option("--org <name-or-id>", "organization name, slug, or ID")
    .action(async (positionalOrgId: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const orgId = await resolveOrgId(
          accounts,
          fmt,
          opts.org,
          positionalOrgId,
        );
        const { members } = await accounts.org.member.list({ orgId });

        output({ members }, fmt, () => {
          if (members.length === 0) {
            console.log("  No members found.");
            return;
          }
          table(
            ["name", "email", "role", "joined"],
            members.map((m) => [m.name, m.email, m.role, m.createdAt]),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOrgMemberAddCommand(): Command {
  return new Command("add")
    .description("add a member to an organization")
    .argument("<email-or-id>", "email address or identity ID")
    .argument("<role>", "role: owner, admin, or member")
    .option("--org <name-or-id>", "organization name, slug, or ID")
    .action(async (emailOrId: string, role: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const orgId = await resolveOrgId(accounts, fmt, opts.org);
        const identityId = await resolveIdentityId(accounts, fmt, emailOrId);
        const member = await accounts.org.member.add({
          orgId,
          identityId,
          role: role as "owner" | "admin" | "member",
        });

        output(member, fmt, () => {
          clack.log.success(
            `Added ${member.name} (${member.email}) as ${member.role}`,
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOrgMemberRemoveCommand(): Command {
  return new Command("remove")
    .description("remove a member from an organization")
    .argument("<name-email-or-id>", "member name, email, or identity ID")
    .option("--org <name-or-id>", "organization name, slug, or ID")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (nameEmailOrId: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const orgId = await resolveOrgId(accounts, fmt, opts.org);
        const member = await resolveMember(accounts, fmt, orgId, nameEmailOrId);

        // Confirm in text mode unless --yes
        if (fmt === "text" && !opts.yes) {
          const label = member.email
            ? `${member.name} (${member.email})`
            : member.name;
          const confirmed = await clack.confirm({
            message: `Remove ${label}?`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }

        const result = await accounts.org.member.remove({
          orgId,
          identityId: member.identityId,
        });

        output(result, fmt, () => {
          if (result.removed) {
            clack.log.success(`Removed ${member.name}.`);
          } else {
            clack.log.warn("Member not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

// =============================================================================
// Command Group
// =============================================================================

function createOrgMemberCommand(): Command {
  const member = new Command("member").description(
    "manage organization members",
  );
  member.addCommand(createOrgMemberListCommand());
  member.addCommand(createOrgMemberAddCommand());
  member.addCommand(createOrgMemberRemoveCommand());
  return member;
}

export function createOrgCommand(): Command {
  const org = new Command("org").description("manage organizations");
  org.addCommand(createOrgListCommand());
  org.addCommand(createOrgCreateCommand());
  org.addCommand(createOrgDeleteCommand());
  org.addCommand(createOrgMemberCommand());
  return org;
}
