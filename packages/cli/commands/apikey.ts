/**
 * me apikey — manage your agents' API keys.
 *
 * Keys are agent-only (humans authenticate with a session) and global: a key
 * works in any space the agent has been admitted to. The plaintext key is shown
 * exactly once, by `create`. There is no revoke state — delete is the removal.
 *
 * - me apikey create <agent> [name] [--expires <ts>]: mint a key (shown once)
 * - me apikey list <agent>:                           list an agent's keys
 * - me apikey get <id>:                               key metadata
 * - me apikey delete <id>:                            delete (revoke) a key
 *
 * <agent> is an agent id or name; <id> is an api-key id.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import {
  buildUserClient,
  handleError,
  requireSession,
  resolveAgentId,
} from "../util.ts";

function createApiKeyCreateCommand(): Command {
  return new Command("create")
    .description("mint an API key for one of your agents")
    .argument("<agent>", "agent id or name")
    .argument("[name]", "key name (auto-generated if omitted)")
    .option("--expires <timestamp>", "expiration timestamp (ISO 8601)")
    .action(async (agent: string, name: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const user = buildUserClient(creds);
      const keyName = name ?? `cli-${new Date().toISOString().slice(0, 10)}`;

      try {
        const agentId = await resolveAgentId(user, agent, fmt);
        const result = await user.apiKey.create({
          agentId,
          name: keyName,
          expiresAt: opts.expires ?? null,
        });
        output(result, fmt, () => {
          clack.log.success(`Created API key '${keyName}'`);
          console.log(`  ID: ${result.id}`);
          clack.note(
            result.key,
            "API key — save it now; it won't be shown again",
          );
          clack.log.info(
            "Give it to the agent via ME_API_KEY or its MCP config. It works in any space the agent is a member of.",
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createApiKeyListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list an agent's API keys")
    .argument("<agent>", "agent id or name")
    .action(async (agent: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const agentId = await resolveAgentId(user, agent, fmt);
        const { apiKeys } = await user.apiKey.list({ memberId: agentId });
        output({ apiKeys }, fmt, () => {
          if (apiKeys.length === 0) {
            console.log("  No API keys.");
            return;
          }
          table(
            ["id", "name", "created", "expires"],
            apiKeys.map((k) => [k.id, k.name, k.createdAt, k.expiresAt ?? ""]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createApiKeyGetCommand(): Command {
  return new Command("get")
    .description("show API key metadata")
    .argument("<id>", "API key id")
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const { apiKey } = await user.apiKey.get({ id });
        output({ apiKey }, fmt, () => {
          if (!apiKey) {
            clack.log.warn("API key not found.");
            return;
          }
          console.log(`  ID:      ${apiKey.id}`);
          console.log(`  Name:    ${apiKey.name}`);
          console.log(`  Agent:   ${apiKey.memberId}`);
          console.log(`  Created: ${apiKey.createdAt}`);
          console.log(`  Expires: ${apiKey.expiresAt ?? "(never)"}`);
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createApiKeyDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description("delete (revoke) an API key")
    .argument("<id>", "API key id")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (id: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      if (fmt === "text" && !opts.yes) {
        const confirmed = await clack.confirm({
          message: `Delete API key ${id}? This revokes it immediately.`,
          initialValue: false,
        });
        if (clack.isCancel(confirmed) || !confirmed) {
          clack.cancel("Cancelled.");
          process.exit(0);
        }
      }

      const user = buildUserClient(creds);
      try {
        const result = await user.apiKey.delete({ id });
        output({ id, ...result }, fmt, () => {
          if (result.deleted) clack.log.success("API key deleted.");
          else clack.log.warn("API key not found.");
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

export function createApiKeyCommand(): Command {
  const apikey = new Command("apikey").description(
    "manage your agents' API keys",
  );
  apikey.addCommand(createApiKeyCreateCommand());
  apikey.addCommand(createApiKeyListCommand());
  apikey.addCommand(createApiKeyGetCommand());
  apikey.addCommand(createApiKeyDeleteCommand());
  return apikey;
}
