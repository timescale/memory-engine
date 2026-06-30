/**
 * me invite — the invitee side of invitations (addressed to your email).
 *
 * - me invite list:           list invitations addressed to your verified email
 * - me invite accept <id>:    accept one, joining the space
 * - me invite decline <id>:   decline (delete) one
 *
 * Distinct from `me space invite`, which is the admin side (inviting others to
 * the active space). Acceptance is explicit — being invited never auto-joins you.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials, setActiveSpace } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import { buildUserClient, handleError, requireAuth } from "../util.ts";

/** Display label for a stored share-access level (null → "none"). */
function shareLabel(level: 1 | 2 | 3 | null): string {
  if (level === null) return "none";
  return level === 1 ? "read" : level === 2 ? "write" : "owner";
}

function createInviteListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list invitations addressed to your email")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const { invitations } = await user.invite.pending();
        output({ invitations }, fmt, () => {
          if (invitations.length === 0) {
            console.log("  No pending invitations.");
            return;
          }
          table(
            ["id", "space", "admin", "share", "invited by"],
            invitations.map((i) => [
              i.invitationId,
              `${i.spaceName} (${i.spaceSlug})`,
              i.admin ? "yes" : "",
              shareLabel(i.shareAccess),
              i.invitedByName ?? "",
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "account" });
      }
    });
}

function createInviteAcceptCommand(): Command {
  return new Command("accept")
    .description("accept an invitation, joining the space")
    .argument("<id>", "the invitation id (from `me invite list`)")
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const result = await user.invite.accept({ invitationId: id });
        // Joining a space is the natural moment to scope the CLI to it. In an
        // interactive terminal, offer to switch; otherwise just print the hint.
        let switched = false;
        if (fmt === "text" && Boolean(process.stdin.isTTY)) {
          const yes = await clack.confirm({
            message: `Switch the active space to ${result.spaceName}?`,
          });
          if (!clack.isCancel(yes) && yes) {
            setActiveSpace(creds.server, result.spaceSlug);
            switched = true;
          }
        }
        output({ ...result, switched }, fmt, () => {
          clack.log.success(
            `Joined ${result.spaceName} (${result.spaceSlug}).`,
          );
          if (!switched) {
            clack.log.info(
              `Run 'me space use ${result.spaceSlug}' to work in it.`,
            );
          }
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "account" });
      }
    });
}

function createInviteDeclineCommand(): Command {
  return new Command("decline")
    .description("decline (delete) an invitation")
    .argument("<id>", "the invitation id (from `me invite list`)")
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const result = await user.invite.decline({ invitationId: id });
        output({ id, ...result }, fmt, () => {
          if (result.declined) {
            clack.log.success("Declined the invitation.");
          } else {
            clack.log.warn(
              "No pending invitation with that id for your email.",
            );
          }
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "account" });
      }
    });
}

export function createInviteCommand(): Command {
  const invite = new Command("invite").description(
    "view and act on invitations addressed to you",
  );
  invite.addCommand(createInviteListCommand());
  invite.addCommand(createInviteAcceptCommand());
  invite.addCommand(createInviteDeclineCommand());
  return invite;
}
