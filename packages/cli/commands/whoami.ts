/**
 * me whoami — show current identity and active engine.
 */
import * as clack from "@clack/prompts";
import { createAccountsClient, RpcError } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";

export function createWhoamiCommand(): Command {
  return new Command("whoami")
    .description("show current identity and active engine")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);

      if (!creds.sessionToken) {
        if (fmt === "text") {
          clack.log.error(
            `Not logged in to ${creds.server}. Run 'me login' first.`,
          );
        } else {
          output(
            { error: "Not logged in", server: creds.server },
            fmt,
            () => {},
          );
        }
        process.exit(1);
      }

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
          hasApiKey: !!creds.apiKey,
        };

        output(data, fmt, () => {
          console.log(`  Name:   ${identity.name}`);
          console.log(`  Email:  ${identity.email}`);
          console.log(`  ID:     ${identity.id}`);
          console.log(`  Server: ${creds.server}`);
          if (creds.apiKey) {
            // Show just the prefix, not the full key
            const prefix = creds.apiKey.split(".").slice(0, 2).join(".");
            console.log(`  Engine: ${prefix}...`);
          } else {
            console.log("  Engine: (none — run 'me engine use' to select)");
          }
        });
      } catch (error) {
        const msg =
          error instanceof RpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);

        if (fmt === "text") {
          clack.log.error(msg);
        } else {
          output({ error: msg, server: creds.server }, fmt, () => {});
        }
        process.exit(1);
      }
    });
}
