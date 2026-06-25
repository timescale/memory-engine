/**
 * me whoami — show the current identity, server, and active space.
 */
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { buildUserClient, handleError, requireAuth } from "../util.ts";

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

        output(
          {
            server: creds.server,
            identity,
            activeSpace: creds.activeSpace ?? null,
          },
          fmt,
          () => {
            console.log(`  Name:   ${identity.name}`);
            console.log(
              `  Kind:   ${identity.kind === "a" ? "agent" : "user"}`,
            );
            // Agents have no email (null); humans always have one.
            if (identity.email !== null)
              console.log(`  Email:  ${identity.email}`);
            console.log(`  ID:     ${identity.id}`);
            console.log(`  Server: ${creds.server}`);
            if (creds.activeSpace) {
              console.log(`  Space:  ${creds.activeSpace}`);
            } else {
              console.log("  Space:  (none — run 'me space use <space>')");
            }
          },
        );
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}
