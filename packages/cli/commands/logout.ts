/**
 * me logout — clear stored credentials for the active server.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { clearServerCredentials, resolveServer } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";

export function createLogoutCommand(): Command {
  return new Command("logout")
    .description("clear stored credentials")
    .action((_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const server = resolveServer(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);

      clearServerCredentials(server);

      output({ server, loggedOut: true }, fmt, () => {
        clack.log.success(`Logged out from ${server}`);
      });
    });
}
