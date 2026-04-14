/**
 * me engine — engine management commands.
 *
 * - me engine list: List engines across all your orgs
 * - me engine use [id-or-name]: Select the active engine
 * - me engine create <name>: Create a new engine in an org
 * - me engine delete <id-or-name>: Permanently delete an engine
 */
import * as clack from "@clack/prompts";
import { createAccountsClient, RpcError } from "@memory-engine/client";
import { Command } from "commander";
import {
  getEngineApiKey,
  resolveCredentials,
  setActiveEngine,
  storeApiKey,
} from "../credentials.ts";
import {
  getOutputFormat,
  type OutputFormat,
  output,
  table,
} from "../output.ts";
import { handleError, requireSession, resolveOrgId } from "../util.ts";

// UUIDv7 pattern for argument detection
const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Flattened engine info with org context.
 */
interface EngineInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
  orgId: string;
  orgName: string;
}

/**
 * Fetch all engines across all the user's orgs.
 */
async function fetchAllEngines(
  accounts: ReturnType<typeof createAccountsClient>,
): Promise<EngineInfo[]> {
  const { orgs } = await accounts.org.list();
  const engines: EngineInfo[] = [];

  for (const org of orgs) {
    const { engines: orgEngines } = await accounts.engine.list({
      orgId: org.id,
    });
    for (const engine of orgEngines) {
      engines.push({
        id: engine.id,
        slug: engine.slug,
        name: engine.name,
        status: engine.status,
        orgId: org.id,
        orgName: org.name,
      });
    }
  }

  return engines;
}

/**
 * me engine list — list engines across all orgs.
 */
function createEngineListCommand(): Command {
  return new Command("list")
    .description("list engines across all your organizations")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);

      if (!creds.sessionToken) {
        if (fmt === "text") {
          clack.log.error("Not logged in. Run 'me login' first.");
        } else {
          output({ error: "Not logged in" }, fmt, () => {});
        }
        process.exit(1);
      }

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const engines = await fetchAllEngines(accounts);

        const data = {
          engines: engines.map((e) => ({
            id: e.id,
            slug: e.slug,
            name: e.name,
            status: e.status,
            orgName: e.orgName,
            active: e.slug === creds.activeEngine,
          })),
        };

        output(data, fmt, () => {
          if (engines.length === 0) {
            console.log("  No engines found.");
            return;
          }
          table(
            ["id", "name", "slug", "org", "status"],
            engines.map((e) => [
              e.id,
              e.name,
              e.slug,
              e.orgName,
              e.slug === creds.activeEngine ? `${e.status} (active)` : e.status,
            ]),
          );
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
          output({ error: msg }, fmt, () => {});
        }
        process.exit(1);
      }
    });
}

/**
 * Resolve an engine argument (ID, name, or interactive picker).
 */
async function resolveEngine(
  engines: EngineInfo[],
  arg: string | undefined,
  fmt: OutputFormat,
): Promise<EngineInfo | null> {
  if (!arg) {
    // No argument — interactive picker
    if (fmt !== "text") {
      output(
        { error: "Engine ID or name is required in non-interactive mode" },
        fmt,
        () => {},
      );
      process.exit(1);
    }

    if (engines.length === 0) {
      clack.log.error("No engines found.");
      process.exit(1);
    }

    const selected = await clack.select({
      message: "Select an engine",
      options: engines.map((e) => ({
        value: e.id,
        label: `${e.name} — ${e.orgName}`,
        hint: e.slug,
      })),
    });

    if (clack.isCancel(selected)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }

    return engines.find((e) => e.id === (selected as string)) ?? null;
  }

  // Argument provided — try to match
  if (UUIDV7_RE.test(arg)) {
    // Looks like a UUID — match by ID
    const match = engines.find((e) => e.id === arg);
    if (!match) {
      const msg = `No engine found with ID: ${arg}`;
      if (fmt === "text") {
        clack.log.error(msg);
      } else {
        output({ error: msg }, fmt, () => {});
      }
      process.exit(1);
    }
    return match;
  }

  // Match by name
  const matches = engines.filter((e) => e.name === arg);
  if (matches.length === 0) {
    const msg = `No engine named '${arg}' found`;
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }
  if (matches.length > 1) {
    const msg = `Multiple engines named '${arg}'. Use the engine ID instead:`;
    if (fmt === "text") {
      clack.log.error(msg);
      for (const m of matches) {
        console.log(`  ${m.id} — ${m.orgName}`);
      }
    } else {
      output(
        {
          error: msg,
          matches: matches.map((m) => ({
            id: m.id,
            orgName: m.orgName,
            slug: m.slug,
          })),
        },
        fmt,
        () => {},
      );
    }
    process.exit(1);
  }

  return matches[0] ?? null;
}

/**
 * me engine use — select the active engine.
 */
function createEngineUseCommand(): Command {
  return new Command("use")
    .description("select the active engine")
    .argument("[id-or-name]", "engine ID or name")
    .action(async (arg: string | undefined, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);

      if (!creds.sessionToken) {
        if (fmt === "text") {
          clack.log.error("Not logged in. Run 'me login' first.");
        } else {
          output({ error: "Not logged in" }, fmt, () => {});
        }
        process.exit(1);
      }

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const engines = await fetchAllEngines(accounts);
        const engine = await resolveEngine(engines, arg, fmt);
        if (!engine) {
          process.exit(1);
        }

        // Check if we already have an API key for this engine
        const existingKey = getEngineApiKey(creds.server, engine.slug);
        if (existingKey) {
          // Already have a key — just switch active engine
          setActiveEngine(creds.server, engine.slug);
          output(
            {
              engine: engine.name,
              slug: engine.slug,
              org: engine.orgName,
              switched: true,
            },
            fmt,
            () => {
              clack.log.success(
                `Switched to engine '${engine.name}' (${engine.orgName})`,
              );
            },
          );
          return;
        }

        // No key — call setupAccess
        const spin = fmt === "text" ? clack.spinner() : null;
        spin?.start("Setting up engine access...");

        const result = await accounts.engine.setupAccess({
          engineId: engine.id,
        });

        // Store the API key and set active engine
        storeApiKey(creds.server, result.engineSlug, result.rawKey);

        spin?.stop("Engine access configured.");

        output(
          {
            engine: result.engineName,
            slug: result.engineSlug,
            org: result.orgName,
            userId: result.userId,
            setup: true,
          },
          fmt,
          () => {
            clack.log.success(
              `Connected to engine '${result.engineName}' (${result.orgName})`,
            );
          },
        );
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
          output({ error: msg }, fmt, () => {});
        }
        process.exit(1);
      }
    });
}

/**
 * me engine create — create a new engine in an org.
 */
function createEngineCreateCommand(): Command {
  return new Command("create")
    .description("create a new engine in an organization")
    .argument("<name>", "engine name")
    .option("--org <id>", "organization ID")
    .option("--language <lang>", "text search language", "english")
    .action(async (name: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        const orgId = await resolveOrgId(accounts, fmt, opts.org);
        const engine = await accounts.engine.create({
          orgId,
          name,
          language: opts.language,
        });

        output(engine, fmt, () => {
          clack.log.success(`Created engine '${engine.name}'`);
          console.log(`  ID:     ${engine.id}`);
          console.log(`  Slug:   ${engine.slug}`);
          console.log(`  Status: ${engine.status}`);
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

/**
 * me engine delete — permanently delete an engine and all its data.
 */
function createEngineDeleteCommand(): Command {
  return new Command("delete")
    .description("permanently delete an engine and all its data")
    .argument("<id-or-name>", "engine ID or name")
    .option("--force", "skip confirmation prompt")
    .action(async (idOrName: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);

      const accounts = createAccountsClient({
        url: creds.server,
        sessionToken: creds.sessionToken,
      });

      try {
        // Resolve engine by ID or name
        const engines = await fetchAllEngines(accounts);
        const engine = await resolveEngine(engines, idOrName, fmt);
        if (!engine) {
          handleError(new Error(`Engine not found: ${idOrName}`), fmt);
        }

        // Confirmation: require typing the engine name
        if (fmt === "text" && !opts.force) {
          clack.log.warn(
            "This will permanently delete the engine and ALL its data (memories, users, grants).",
          );
          clack.log.warn("This action cannot be undone.");
          console.log();

          const confirmation = await clack.text({
            message: `Type the engine name "${engine.name}" to confirm deletion`,
            validate: (value) => {
              if (value !== engine.name) {
                return `Please type "${engine.name}" exactly to confirm`;
              }
            },
          });

          if (clack.isCancel(confirmation)) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }

        const result = await accounts.engine.delete({ id: engine.id });

        output(result, fmt, () => {
          if (result.deleted) {
            clack.log.success(
              `Engine '${engine.name}' has been permanently deleted.`,
            );
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

/**
 * Create the engine command group.
 */
export function createEngineCommand(): Command {
  const engine = new Command("engine").description("manage engines");

  engine.addCommand(createEngineListCommand());
  engine.addCommand(createEngineUseCommand());
  engine.addCommand(createEngineCreateCommand());
  engine.addCommand(createEngineDeleteCommand());

  return engine;
}
