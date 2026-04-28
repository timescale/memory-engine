/**
 * me whoami — show current identity and active engine.
 */
import { Command } from "commander";
import { createAccountsClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireSession } from "../util.ts";

export function createWhoamiCommand(): Command {
  return new Command("whoami")
    .description("show current identity and active engine")
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
        const identity = await accounts.me.get();

        const data: Record<string, unknown> = {
          server: creds.server,
          identity: {
            id: identity.id,
            name: identity.name,
            email: identity.email,
          },
          activeEngine: creds.activeEngine ?? null,
          hasApiKey: !!creds.apiKey,
        };

        output(data, fmt, () => {
          console.log(`  Name:   ${identity.name}`);
          console.log(`  Email:  ${identity.email}`);
          console.log(`  ID:     ${identity.id}`);
          console.log(`  Server: ${creds.server}`);
          if (creds.activeEngine) {
            console.log(`  Engine: ${creds.activeEngine}`);
          } else {
            console.log("  Engine: (none — run 'me engine use' to select)");
          }
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}
