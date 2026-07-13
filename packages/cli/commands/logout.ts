/**
 * me logout — clear stored credentials for the active server.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { clearServerCredentials, resolveServer } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { rejectActAsAgentForSessionCommand } from "../util.ts";

export function createLogoutCommand(): Command {
  return new Command("logout")
    .description("clear stored credentials")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const server = resolveServer(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);

      await rejectActAsAgentForSessionCommand("logout", fmt);

      clearServerCredentials(server);

      await output({ server, loggedOut: true }, fmt, () => {
        clack.log.success(`Logged out from ${server}`);
        // logout only clears local CLI credentials — the browser may still hold
        // a session for this account, so a plain re-login lands you right back
        // in it. `me login --switch` forces the sign-in page to switch accounts.
        // `outro` closes the clack run with the `└` end symbol.
        clack.outro(
          "To sign in as a different account, run 'me login --switch'.",
        );
      });
    });
}
