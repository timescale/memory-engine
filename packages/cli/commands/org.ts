/**
 * me org — organization management commands.
 *
 * - me org list: List your organizations
 * - me org create <name>: Create an organization
 * - me org delete <id>: Delete an organization
 * - me org member list [org-id]: List members
 * - me org member add <identity-id> <role>: Add a member
 * - me org member remove <identity-id>: Remove a member
 */
import * as clack from "@clack/prompts";
import { createAccountsClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireSession, resolveOrgId } from "../util.ts";

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
          for (const org of orgs) {
            console.log(`  ${org.name} [${org.slug}] — ${org.id}`);
          }
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
    .argument("<id>", "organization ID")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (id: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      // Confirm in text mode unless --yes
      if (fmt === "text" && !opts.yes) {
        const confirmed = await clack.confirm({
          message: `Delete organization ${id}? This cannot be undone.`,
        });
        if (clack.isCancel(confirmed) || !confirmed) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
      }

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const result = await accounts.org.delete({ id });

        output(result, fmt, () => {
          if (result.deleted) {
            clack.log.success("Organization deleted.");
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
    .argument("[org-id]", "organization ID (optional if you belong to one org)")
    .option("--org <id>", "organization ID")
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
          for (const m of members) {
            console.log(
              `  ${m.identityId}  ${m.role.padEnd(8)}  joined ${m.createdAt}`,
            );
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOrgMemberAddCommand(): Command {
  return new Command("add")
    .description("add a member to an organization")
    .argument("<identity-id>", "identity ID to add")
    .argument("<role>", "role: owner, admin, or member")
    .option("--org <id>", "organization ID")
    .action(async (identityId: string, role: string, opts, cmd) => {
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
        const member = await accounts.org.member.add({
          orgId,
          identityId,
          role: role as "owner" | "admin" | "member",
        });

        output(member, fmt, () => {
          clack.log.success(`Added ${member.identityId} as ${member.role}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createOrgMemberRemoveCommand(): Command {
  return new Command("remove")
    .description("remove a member from an organization")
    .argument("<identity-id>", "identity ID to remove")
    .option("--org <id>", "organization ID")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (identityId: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      // Confirm in text mode unless --yes
      if (fmt === "text" && !opts.yes) {
        const confirmed = await clack.confirm({
          message: `Remove member ${identityId}?`,
        });
        if (clack.isCancel(confirmed) || !confirmed) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
      }

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const orgId = await resolveOrgId(accounts, fmt, opts.org);
        const result = await accounts.org.member.remove({
          orgId,
          identityId,
        });

        output(result, fmt, () => {
          if (result.removed) {
            clack.log.success("Member removed.");
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
