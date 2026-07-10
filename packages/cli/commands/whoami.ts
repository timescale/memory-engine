/**
 * me whoami — show the current identity, server, and active space.
 */
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { authLabel, authMethodOf, formatSpaceLabel } from "../identity.ts";
import { getOutputFormat, output } from "../output.ts";
import { buildUserClient, handleError, requireAuth } from "../util.ts";

function kindLabel(kind: "u" | "a" | "s"): string {
  switch (kind) {
    case "u":
      return "user";
    case "a":
      return "agent";
    case "s":
      return "service account";
    default:
      throw new Error(`unexpected principal kind: ${kind}`);
  }
}

export function createWhoamiCommand(): Command {
  return new Command("whoami")
    .description("show current identity, server, and active space")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);

      try {
        const identity = await user.whoami();
        const auth = authMethodOf(creds, identity.kind);

        // Resolve the active-space slug to its full record (name + admin) for a
        // friendlier display. Best-effort: only when a space is set, and a
        // space.list failure falls back to the bare slug so whoami never breaks
        // over the extra round-trip. When `resolved` is true, `space === null`
        // means the stored slug is stale; when `resolved` is false, the lookup failed.
        let space: MemberSpaceResponse | null = null;
        let resolved = true;
        if (creds.activeSpace) {
          try {
            const { spaces } = await user.space.list();
            space = spaces.find((s) => s.slug === creds.activeSpace) ?? null;
          } catch {
            resolved = false;
          }
        }

        output(
          {
            server: creds.server,
            identity,
            activeSpace: creds.activeSpace ?? null,
            space,
            auth,
          },
          fmt,
          () => {
            console.log(`  Name:   ${identity.name}`);
            console.log(`  Kind:   ${kindLabel(identity.kind)}`);
            // Non-users have no email (null); humans always have one.
            if (identity.email !== null)
              console.log(`  Email:  ${identity.email}`);
            console.log(`  ID:     ${identity.id}`);
            console.log(`  Auth:   ${authLabel(auth)}`);
            console.log(`  Server: ${creds.server}`);
            if (!creds.activeSpace) {
              console.log("  Space:  (none — run 'me space use <space>')");
            } else if (space) {
              console.log(`  Space:  ${formatSpaceLabel(space)}`);
            } else if (resolved) {
              // Slug is set but no longer matches one of your spaces.
              console.log(
                `  Space:  ${creds.activeSpace} (not found — you may have been removed; run 'me space use <space>')`,
              );
            } else {
              // Couldn't reach space.list — show the raw slug.
              console.log(`  Space:  ${creds.activeSpace}`);
            }
          },
        );
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}
