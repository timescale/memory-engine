/**
 * me version — print client + server versions and verify compatibility.
 *
 * Useful for diagnostics. Prints the CLI version unconditionally; if a
 * server is reachable, also prints the server version and reports whether
 * the two are compatible. Exits non-zero on incompatibility so this can
 * be used as a CI gate.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  CLIENT_VERSION,
  MIN_CLIENT_VERSION,
  MIN_SERVER_VERSION,
} from "../../../version";
import { checkServerVersion, RpcError } from "../client.ts";
import { resolveServer } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";

export function createVersionCommand(): Command {
  return new Command("version")
    .description("show CLI and server versions and check compatibility")
    .option(
      "--local",
      "skip the server probe; print only the local CLI version",
    )
    .action(async (opts: { local?: boolean }, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const fmt = getOutputFormat(globalOpts);

      // Local CLI info, always printed.
      const local = {
        clientVersion: CLIENT_VERSION,
        // We surface our own MIN_SERVER_VERSION so users can debug version
        // policy mismatches without spelunking through the source.
        minServerVersion: MIN_SERVER_VERSION,
        // The local MIN_CLIENT_VERSION is mostly informational (the server's
        // bound is the one that matters at runtime), but useful for symmetry.
        bundledMinClientVersion: MIN_CLIENT_VERSION,
      };

      if (opts.local) {
        await output({ ...local, server: null }, fmt, () => {
          console.log(`  Client version:  ${local.clientVersion}`);
          console.log(`  Min server:      ${local.minServerVersion}`);
        });
        return;
      }

      // The global option is `--server <url>` and may also leak through as
      // `globalOpts.server` for parent flags. Only pass it through to
      // resolveServer when it is actually a string.
      const serverFlag =
        typeof globalOpts.server === "string" ? globalOpts.server : undefined;
      const server = resolveServer(serverFlag);

      try {
        const probe = await checkServerVersion({
          url: server,
          clientVersion: CLIENT_VERSION,
          minServerVersion: MIN_SERVER_VERSION,
        });

        const data = {
          ...local,
          server: {
            url: server,
            version: probe.serverVersion,
            minClientVersion: probe.minClientVersion,
            compatible: true,
          },
        };

        await output(data, fmt, () => {
          console.log(`  Client version:  ${local.clientVersion}`);
          console.log(`  Server:          ${server}`);
          console.log(`  Server version:  ${probe.serverVersion}`);
          console.log(`  Min client:      ${probe.minClientVersion}`);
          console.log(`  Min server:      ${local.minServerVersion}`);
          clack.log.success("Versions are compatible.");
        });
      } catch (error) {
        const isRpc = error instanceof RpcError;
        const msg = isRpc
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);

        const data = {
          ...local,
          server: {
            url: server,
            version: null,
            compatible: false,
            error: msg,
            errorCode: isRpc ? error.appCode : undefined,
          },
        };

        await output(data, fmt, () => {
          console.log(`  Client version:  ${local.clientVersion}`);
          console.log(`  Server:          ${server}`);
          clack.log.error(msg);
        });

        process.exit(1);
      }
    });
}
