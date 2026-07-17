/**
 * me apikey — manage API keys, for yourself (a personal access token), your
 * agents (`--agent`), or service accounts (`--service`).
 *
 * Keys are global: a key works in any space its principal has been admitted to.
 * The plaintext key is shown exactly once, by `create`. No revoke state — delete
 * is the removal. A personal access token has full access as you (headless/CLI
 * use); minting/revoking always requires a `me login` session.
 *
 * - me apikey create [name] [--expires <ts>|--ttl <duration>]: mint a PAT (you)
 * - me apikey create --agent <agent> [name]:   mint a key for one of your agents
 * - me apikey create --service <svc> [name]:   mint a service-account key
 * - me apikey list [--agent <agent>|--service <svc>]
 * - me apikey get <id>:                      key metadata
 * - me apikey delete <id>:                   delete (revoke) a key
 *
 * <agent> is an agent id or name; <id> is an api-key id.
 */
import { randomBytes } from "node:crypto";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import {
  getOutputFormat,
  type OutputFormat,
  output,
  table,
} from "../output.ts";
import {
  buildUserClient,
  handleError,
  requireAuth,
  requireSession,
  requireSpace,
  resolveActiveSpace,
  resolveAgentId,
  resolveServiceAccountId,
} from "../util.ts";

/**
 * Default name for an unnamed key. The random suffix keeps two unnamed keys
 * minted for the same principal on the same day from colliding on the
 * `unique (member_id, name)` constraint.
 */
function defaultKeyName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `cli-${date}-${randomBytes(6).toString("hex")}`;
}

function assertSingleTarget(
  agent: string | undefined,
  service: string | undefined,
  fmt: OutputFormat,
): void {
  if (agent === undefined || service === undefined) return;
  failWith("Use only one key target: --agent or --service, not both.", fmt);
}

function failWith(message: string, fmt: OutputFormat): never {
  if (fmt === "text") clack.log.error(message);
  else output({ error: message }, fmt, () => {});
  process.exit(1);
}

/** Parse a duration like "30d" / "24h" / "30m" into an ISO expiry timestamp. */
function parseTtl(raw: string, fmt: OutputFormat): string {
  const m = /^(\d+)([dhm])$/.exec(raw.trim());
  if (!m) {
    failWith(`Invalid --ttl '${raw}'. Use <n>d | <n>h | <n>m (e.g. 30d).`, fmt);
  }
  const n = Number(m?.[1]);
  if (!Number.isSafeInteger(n) || n <= 0) {
    failWith(`Invalid --ttl '${raw}'. Use a positive duration like 30d.`, fmt);
  }
  const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m?.[2] ?? "d"] ?? 0;
  return new Date(Date.now() + n * unitMs).toISOString();
}

function resolveExpiresAt(
  opts: { expires?: string; ttl?: string },
  fmt: OutputFormat,
): string | null {
  if (opts.expires !== undefined && opts.ttl !== undefined) {
    failWith(
      "Use only one expiration option: --expires or --ttl, not both.",
      fmt,
    );
  }
  if (opts.ttl !== undefined) return parseTtl(opts.ttl, fmt);
  return opts.expires ?? null;
}

async function resolveApiKeyTarget(
  user: ReturnType<typeof buildUserClient>,
  creds: ReturnType<typeof resolveCredentials>,
  fmt: OutputFormat,
  opts: { agent?: string; service?: string },
): Promise<{ memberId: string; targetKind: "user" | "agent" | "service" }> {
  assertSingleTarget(opts.agent, opts.service, fmt);
  if (opts.agent !== undefined) {
    return {
      memberId: await resolveAgentId(user, opts.agent, fmt),
      targetKind: "agent",
    };
  }
  if (opts.service !== undefined) {
    requireSpace(creds, fmt);
    const space = await resolveActiveSpace(user, creds.activeSpace, fmt);
    return {
      memberId: await resolveServiceAccountId(
        user,
        space.id,
        opts.service,
        fmt,
      ),
      targetKind: "service",
    };
  }
  return { memberId: (await user.whoami()).id, targetKind: "user" };
}

function createApiKeyCreateCommand(): Command {
  return new Command("create")
    .description(
      "mint a personal access token, agent key, or service-account key",
    )
    .argument("[name]", "key name (auto-generated if omitted)")
    .option(
      "--agent <agent>",
      "mint a key for one of your agents instead of yourself (agent id or name)",
    )
    .option(
      "--service <service>",
      "mint a key for a service account in the active space (id or name)",
    )
    .option("--expires <timestamp>", "expiration timestamp (ISO 8601)")
    .option("--ttl <duration>", "expiration from now, e.g. 30d | 24h | 30m")
    .action(async (name: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const user = buildUserClient(creds);
      const keyName = name ?? defaultKeyName();

      try {
        const expiresAt = resolveExpiresAt(opts, fmt);
        const { memberId, targetKind } = await resolveApiKeyTarget(
          user,
          creds,
          fmt,
          opts,
        );
        const result = await user.apiKey.create({
          memberId,
          name: keyName,
          expiresAt,
        });
        output(result, fmt, () => {
          clack.log.success(`Created API key '${keyName}'`);
          console.log(`  ID: ${result.id}`);
          clack.note(
            result.key,
            "API key — save it now; it won't be shown again",
          );
          clack.log.info(
            targetKind === "agent"
              ? "Give it to the agent via ME_API_KEY or its MCP config. It works in any space the agent is a member of."
              : targetKind === "service"
                ? "Service-account key — store it as a production secret (for example, ME_API_KEY in CI). It works only in spaces where the service account belongs and has access."
                : "Personal access token — use it as ME_API_KEY for headless/CLI access as you (e.g. in a VM or over SSH). It works in any space you're a member of. Managing keys (create/revoke) still requires `me login`.",
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createApiKeyListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list your API keys, an agent's, or a service account's")
    .option(
      "--agent <agent>",
      "list one of your agents' keys instead of your own (agent id or name)",
    )
    .option(
      "--service <service>",
      "list a service account's keys in the active space (id or name)",
    )
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const { memberId } = await resolveApiKeyTarget(user, creds, fmt, opts);
        const { apiKeys } = await user.apiKey.list({ memberId });
        output({ apiKeys }, fmt, () => {
          if (apiKeys.length === 0) {
            console.log("  No API keys.");
            return;
          }
          table(
            ["id", "name", "created", "expires", "last used"],
            apiKeys.map((k) => [
              k.id,
              k.name,
              k.createdAt,
              k.expiresAt ?? "",
              k.lastUsedOn ?? "",
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
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
      requireAuth(creds, fmt);

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
          console.log(`  Member:  ${apiKey.memberId}`);
          console.log(`  Created: ${apiKey.createdAt}`);
          console.log(`  Expires: ${apiKey.expiresAt ?? "(never)"}`);
          console.log(`  Last used: ${apiKey.lastUsedOn ?? "(never)"}`);
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createApiKeyDeleteCommand(): Command {
  return new Command("delete")
    .aliases(["rm", "revoke"])
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
        handleError(error, fmt, { creds });
      }
    });
}

export function createApiKeyCommand(): Command {
  const apikey = new Command("apikey").description(
    "manage API keys (personal, agent, or service-account keys)",
  );
  apikey.addCommand(createApiKeyCreateCommand());
  apikey.addCommand(createApiKeyListCommand());
  apikey.addCommand(createApiKeyGetCommand());
  apikey.addCommand(createApiKeyDeleteCommand());
  return apikey;
}
