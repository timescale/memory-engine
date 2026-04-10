/**
 * me apikey — API key management commands.
 *
 * - me apikey list <user-id>: List API keys for a user
 * - me apikey create <user-id> [name]: Create a new API key
 * - me apikey revoke <id>: Revoke an API key
 * - me apikey delete <id>: Permanently delete an API key
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";

function createApiKeyListCommand(): Command {
  return new Command("list")
    .description("list API keys for a user")
    .argument("<user-id>", "user ID")
    .action(async (userId: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const { apiKeys } = await engine.apiKey.list({ userId });

        output({ apiKeys }, fmt, () => {
          if (apiKeys.length === 0) {
            console.log("  No API keys found.");
            return;
          }
          for (const k of apiKeys) {
            const revoked = k.revokedAt ? " (revoked)" : "";
            const lastUsed = k.lastUsedAt
              ? `last used ${k.lastUsedAt}`
              : "never used";
            console.log(
              `  ${k.name.padEnd(20)} ${k.id}  ${lastUsed}${revoked}`,
            );
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createApiKeyCreateCommand(): Command {
  return new Command("create")
    .description("create a new API key")
    .argument("<user-id>", "user ID")
    .argument("[name]", "key name (auto-generated if omitted)")
    .option("--expires <timestamp>", "expiration timestamp (ISO 8601)")
    .action(async (userId: string, name: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({
        url: creds.server,
        apiKey: creds.apiKey,
      });

      const keyName = name ?? `cli-${new Date().toISOString().slice(0, 10)}`;

      try {
        const result = await engine.apiKey.create({
          userId,
          name: keyName,
          expiresAt: opts.expires ?? undefined,
        });

        output(result, fmt, () => {
          clack.log.success(`Created API key '${result.apiKey.name}'`);
          console.log(`  ID: ${result.apiKey.id}`);
          clack.note(
            result.rawKey,
            "API Key (save this — it won't be shown again)",
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createApiKeyRevokeCommand(): Command {
  return new Command("revoke")
    .description("revoke an API key")
    .argument("<id>", "API key ID")
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.apiKey.revoke({ id });

        output(result, fmt, () => {
          if (result.revoked) {
            clack.log.success("API key revoked.");
          } else {
            clack.log.warn("API key not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

function createApiKeyDeleteCommand(): Command {
  return new Command("delete")
    .description("permanently delete an API key")
    .argument("<id>", "API key ID")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (id: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      if (fmt === "text" && !opts.yes) {
        const confirmed = await clack.confirm({
          message: `Permanently delete API key ${id}?`,
        });
        if (clack.isCancel(confirmed) || !confirmed) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
      }

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const result = await engine.apiKey.delete({ id });

        output(result, fmt, () => {
          if (result.deleted) {
            clack.log.success("API key deleted.");
          } else {
            clack.log.warn("API key not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

export function createApiKeyCommand(): Command {
  const apikey = new Command("apikey").description("manage API keys");
  apikey.addCommand(createApiKeyListCommand());
  apikey.addCommand(createApiKeyCreateCommand());
  apikey.addCommand(createApiKeyRevokeCommand());
  apikey.addCommand(createApiKeyDeleteCommand());
  return apikey;
}
