/**
 * me invitation — invitation management commands.
 *
 * - me invitation create <email> <role>: Invite someone to an organization
 * - me invitation list [org-id]: List pending invitations
 * - me invitation accept <token>: Accept an invitation
 * - me invitation revoke <id>: Revoke an invitation
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { createAccountsClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import { handleError, requireSession, resolveOrgId } from "../util.ts";

// =============================================================================
// Invitation Commands
// =============================================================================

function createInvitationCreateCommand(): Command {
  return new Command("create")
    .description("invite someone to an organization")
    .argument("<email>", "email address to invite")
    .argument("<role>", "role: owner, admin, or member")
    .option("--org <name-or-id>", "organization name, slug, or ID")
    .option("--expires <days>", "expiration in days (1-30, default 7)", "7")
    .action(async (email: string, role: string, opts, cmd) => {
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
        const expiresInDays = Number.parseInt(opts.expires, 10);

        const result = await accounts.invitation.create({
          orgId,
          email,
          role: role as "owner" | "admin" | "member",
          expiresInDays,
        });

        output(result, fmt, () => {
          clack.log.success(`Invitation sent to ${result.email}`);
          console.log(`  ID:      ${result.id}`);
          console.log(`  Role:    ${result.role}`);
          console.log(`  Expires: ${result.expiresAt}`);
          clack.note(
            result.token,
            "Invitation token (share this with the invitee)",
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createInvitationListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list pending invitations")
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
        const { invitations } = await accounts.invitation.list({ orgId });

        output({ invitations }, fmt, () => {
          if (invitations.length === 0) {
            console.log("  No pending invitations.");
            return;
          }
          table(
            ["id", "email", "role", "expires"],
            invitations.map((inv) => [
              inv.id,
              inv.email,
              inv.role,
              inv.expiresAt,
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createInvitationAcceptCommand(): Command {
  return new Command("accept")
    .description("accept an invitation")
    .argument("<token>", "invitation token")
    .action(async (token: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const result = await accounts.invitation.accept({ token });

        // Resolve org name for a friendlier message
        let orgName: string | undefined;
        if (result.accepted) {
          try {
            const org = await accounts.org.get({ id: result.orgId });
            orgName = org.name;
          } catch {
            // Fall back to ID if org lookup fails
          }
        }

        output(result, fmt, () => {
          if (result.accepted) {
            const label = orgName ? `'${orgName}'` : result.orgId;
            clack.log.success(`Invitation accepted! Joined ${label}.`);
          } else {
            clack.log.warn("Invitation could not be accepted.");
          }
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createInvitationRevokeCommand(): Command {
  return new Command("revoke")
    .description("revoke a pending invitation")
    .argument("<id>", "invitation ID")
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const result = await accounts.invitation.revoke({ id });

        output(result, fmt, () => {
          if (result.revoked) {
            clack.log.success("Invitation revoked.");
          } else {
            clack.log.warn("Invitation not found or already used.");
          }
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

// =============================================================================
// Command Group
// =============================================================================

export function createInvitationCommand(): Command {
  const invitation = new Command("invitation").description(
    "manage invitations",
  );
  invitation.addCommand(createInvitationCreateCommand());
  invitation.addCommand(createInvitationListCommand());
  invitation.addCommand(createInvitationAcceptCommand());
  invitation.addCommand(createInvitationRevokeCommand());
  return invitation;
}
