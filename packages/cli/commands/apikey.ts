/**
 * me apikey — manage API keys for yourself (a personal access token) or service
 * accounts (`--service`).
 *
 * Unrestricted keys work in any space their principal has been admitted to;
 * restricted keys are capped to explicit declarations.
 * The plaintext key is shown exactly once, by `create`. No revoke state — delete
 * is the removal. A personal access token can be full-access or restricted for
 * headless/CLI use; minting/revoking always requires a `me login` session.
 *
 * - me apikey create [name] [--expires <ts>|--ttl <duration>|--allow <scope>]: mint a PAT (you)
 * - me apikey create --service <svc> [name]:   mint a service-account key
 * - me apikey list [--service <svc>]
 * - me apikey get <id>:                      key metadata
 * - me apikey delete <id>:                   delete (revoke) a key
 *
 * <id> is an API-key id.
 */
import { randomBytes } from "node:crypto";
import * as clack from "@clack/prompts";
import { parseAccessLevel } from "@memory.build/protocol/space";
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
  resolveServiceAccountId,
} from "../util.ts";

type ApiKeyTarget = {
  memberId: string;
  targetKind: "user" | "service";
  spaceId?: string;
};

type ParsedAllow = {
  space: string;
  treePath?: string;
  access?: 1 | 2 | 3;
};

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Parse `<space>` or `<space>:<path>:<r|w|o>` without resolving its space. */
export function parseAllow(raw: string, fmt: OutputFormat): ParsedAllow {
  const parts = raw.split(":");
  if (parts.length === 1 && parts[0]) return { space: parts[0] };
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    failWith(
      `Invalid --allow '${raw}'. Use <space> or <space>:<path>:<r|w|o>.`,
      fmt,
    );
  }
  const parsedAccess = parseAccessLevel(parts[2]);
  if (!parsedAccess) {
    failWith(`Invalid access level in --allow '${raw}'. Use r, w, or o.`, fmt);
  }
  const access = parsedAccess ?? failWith("Invalid --allow access level.", fmt);
  return { space: parts[0], treePath: parts[1], access };
}

/**
 * Default name for an unnamed key. The random suffix keeps two unnamed keys
 * minted for the same principal on the same day from colliding on the
 * `unique (member_id, name)` constraint.
 */
function defaultKeyName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `cli-${date}-${randomBytes(6).toString("hex")}`;
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
  opts: { service?: string },
): Promise<ApiKeyTarget> {
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
      spaceId: space.id,
    };
  }
  return { memberId: (await user.whoami()).id, targetKind: "user" };
}

async function resolveApiKeyAccess(
  user: ReturnType<typeof buildUserClient>,
  creds: ReturnType<typeof resolveCredentials>,
  target: ApiKeyTarget,
  opts: { allow?: string[]; spaceAdmin?: string[] },
  fmt: OutputFormat,
) {
  const allows = opts.allow ?? [];
  const adminSpaces = opts.spaceAdmin ?? [];
  if (allows.length === 0 && adminSpaces.length === 0) return undefined;
  if (allows.length === 0) {
    failWith("A restricted key needs at least one --allow declaration.", fmt);
  }

  const { spaces } = await user.space.list();
  const active = creds.activeSpace;
  const resolveSpace = (ref: string) => {
    const resolved = ref === "." ? active : ref;
    if (!resolved) {
      failWith(
        "--allow . requires an active space. Run 'me space use <space>'.",
        fmt,
      );
    }
    const space = spaces.find((s) => s.slug === resolved || s.id === resolved);
    if (!space) {
      failWith(
        `No declared space matches '${ref}'. Use a space slug from 'me space list'.`,
        fmt,
      );
    }
    if (target.spaceId && space.id !== target.spaceId) {
      failWith(
        "A service-account key can declare access only in the service account's active space.",
        fmt,
      );
    }
    return space;
  };

  const declarations = new Map<
    string,
    {
      spaceId: string;
      spaceAdmin: boolean;
      grants: Array<{ treePath: string; access: 1 | 2 | 3 }>;
    }
  >();
  for (const raw of allows) {
    const parsed = parseAllow(raw, fmt);
    const space = resolveSpace(parsed.space);
    const declaration = declarations.get(space.id) ?? {
      spaceId: space.id,
      spaceAdmin: false,
      grants: [],
    };
    if (parsed.treePath === undefined) {
      if (declarations.has(space.id)) {
        failWith(`Duplicate --allow declaration for ${parsed.space}.`, fmt);
      }
      if (declaration.grants.length > 0) {
        failWith(
          `--allow ${parsed.space} cannot be combined with tree grants for that space.`,
          fmt,
        );
      }
      declarations.set(space.id, declaration);
      continue;
    }
    if (declarations.has(space.id) && declaration.grants.length === 0) {
      failWith(
        `--allow ${parsed.space} has full access and cannot add a tree grant.`,
        fmt,
      );
    }
    if (
      declaration.grants.some((grant) => grant.treePath === parsed.treePath)
    ) {
      failWith(
        `Duplicate --allow tree path '${parsed.treePath}' for ${parsed.space}.`,
        fmt,
      );
    }
    const access =
      parsed.access ?? failWith("Invalid --allow access level.", fmt);
    declaration.grants.push({ treePath: parsed.treePath, access });
    declarations.set(space.id, declaration);
  }
  for (const ref of adminSpaces) {
    const space = resolveSpace(ref);
    const declaration = declarations.get(space.id);
    if (!declaration) {
      failWith(
        `--space-admin ${ref} requires an --allow declaration for that space.`,
        fmt,
      );
    }
    declaration.spaceAdmin = true;
  }
  return [...declarations.values()];
}

function displayTreePath(treePath: string): string {
  return treePath === "" ? "/" : `/${treePath.replaceAll(".", "/")}`;
}

function createApiKeyCreateCommand(): Command {
  return new Command("create")
    .description("mint a personal access token or service-account key")
    .argument("[name]", "key name (auto-generated if omitted)")
    .option(
      "--service <service>",
      "mint a key for a service account in the active space (id or name)",
    )
    .option("--expires <timestamp>", "expiration timestamp (ISO 8601)")
    .option("--ttl <duration>", "expiration from now, e.g. 30d | 24h | 30m")
    .option(
      "--allow <declaration>",
      "repeatable scope: <space> or <space>:<path>:<r|w|o>",
      collectOption,
      [],
    )
    .option(
      "--space-admin <space>",
      "allow space-admin authority in a declared space (repeatable)",
      collectOption,
      [],
    )
    .action(async (name: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const user = buildUserClient(creds);
      const keyName = name ?? defaultKeyName();

      try {
        const expiresAt = resolveExpiresAt(opts, fmt);
        const target = await resolveApiKeyTarget(user, creds, fmt, opts);
        const { memberId, targetKind } = target;
        const access = await resolveApiKeyAccess(
          user,
          creds,
          target,
          opts,
          fmt,
        );
        const result = await user.apiKey.create({
          memberId,
          name: keyName,
          expiresAt,
          access,
        });
        output(result, fmt, () => {
          clack.log.success(
            `Created ${access ? "restricted " : ""}API key '${keyName}'`,
          );
          console.log(`  ID: ${result.id}`);
          clack.note(
            result.key,
            "API key — save it now; it won't be shown again",
          );
          clack.log.info(
            targetKind === "service"
              ? "Service-account key — store it as a production secret (for example, ME_API_KEY in CI). It works only in spaces where the service account belongs and has access."
              : access
                ? "Restricted personal access token — use it as ME_API_KEY only where its declared scope is intended. Managing keys still requires `me login`."
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
    .description("list your API keys or a service account's")
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
            ["id", "name", "scope", "created", "expires", "last used"],
            apiKeys.map((k) => [
              k.id,
              k.name,
              k.restricted ? "restricted" : "full",
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
        const { apiKey, access } = await user.apiKey.get({ id });
        output({ apiKey, access }, fmt, () => {
          if (!apiKey) {
            clack.log.warn("API key not found.");
            return;
          }
          console.log(`  ID:      ${apiKey.id}`);
          console.log(`  Name:    ${apiKey.name}`);
          console.log(`  Member:  ${apiKey.memberId}`);
          console.log(
            `  Scope:   ${apiKey.restricted ? "restricted" : "full"}`,
          );
          console.log(`  Created: ${apiKey.createdAt}`);
          console.log(`  Expires: ${apiKey.expiresAt ?? "(never)"}`);
          console.log(`  Last used: ${apiKey.lastUsedOn ?? "(never)"}`);
          if (apiKey.restricted) {
            table(
              ["space", "admin", "tree_path", "access"],
              access.flatMap((declaration) =>
                declaration.grants.length === 0
                  ? [
                      [
                        declaration.slug,
                        declaration.spaceAdmin ? "yes" : "",
                        "all holder access",
                        "",
                      ],
                    ]
                  : declaration.grants.map((grant) => [
                      declaration.slug,
                      declaration.spaceAdmin ? "yes" : "",
                      displayTreePath(grant.treePath),
                      grant.access === 1
                        ? "read"
                        : grant.access === 2
                          ? "write"
                          : "owner",
                    ]),
              ),
            );
          }
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
    "manage API keys (personal or service-account keys)",
  );
  apikey.addCommand(createApiKeyCreateCommand());
  apikey.addCommand(createApiKeyListCommand());
  apikey.addCommand(createApiKeyGetCommand());
  apikey.addCommand(createApiKeyDeleteCommand());
  return apikey;
}
