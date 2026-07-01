/**
 * me invite — the invitee side of invitations (addressed to your email).
 *
 * - me invite list:            list invitations addressed to your verified email
 * - me invite accept <id>:     accept one, joining the space
 * - me invite decline <id>:    decline (delete) one
 * - me invite redeem <link>:   redeem a magic-link invite (URL or raw token)
 *
 * Distinct from `me space invite`, which is the admin side (inviting others to
 * the active space). Acceptance is explicit — being invited never auto-joins you.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials, setActiveSpace } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import { buildUserClient, handleError, requireAuth } from "../util.ts";

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
            ["id", "space", "admin", "group", "invited by"],
            invitations.map((i) => [
              i.invitationId,
              `${i.spaceName} (${i.spaceSlug})`,
              i.admin ? "yes" : "",
              i.groupName ?? "—",
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

/** Extract the raw token from a full invite URL (…/invite/<token>) or pass through. */
function extractToken(input: string): string {
  const trimmed = input.trim();
  const marker = "/invite/";
  const at = trimmed.lastIndexOf(marker);
  const raw = at >= 0 ? trimmed.slice(at + marker.length) : trimmed;
  // strip any query/fragment/trailing slash
  return raw.split(/[?#/]/)[0] ?? raw;
}

function createInviteRedeemCommand(): Command {
  return new Command("redeem")
    .description("redeem a magic-link invite (paste the URL or the token)")
    .argument("<link>", "the invite URL or raw token")
    .action(async (link: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const result = await user.invite.redeem({ token: extractToken(link) });
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

export function createInviteCommand(): Command {
  const invite = new Command("invite").description(
    "view and act on invitations addressed to you",
  );
  invite.addCommand(createInviteListCommand());
  invite.addCommand(createInviteAcceptCommand());
  invite.addCommand(createInviteDeclineCommand());
  invite.addCommand(createInviteRedeemCommand());
  return invite;
}
