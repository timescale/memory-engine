/**
 * me pack — memory pack management commands.
 *
 * - me pack validate <file>: Validate a pack file locally
 * - me pack install <file>: Install a memory pack into the active engine
 * - me pack list: List installed packs in the active engine
 */

import { readFileSync } from "node:fs";
import * as clack from "@clack/prompts";
import { createClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import { parsePack, validatePackConstraints } from "../parsers/pack.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";

// =============================================================================
// Validate
// =============================================================================

function createPackValidateCommand(): Command {
  return new Command("validate")
    .description("validate a memory pack file")
    .argument("<file>", "pack YAML file to validate")
    .action(async (file: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const fmt = getOutputFormat(globalOpts);

      try {
        const content = readFileSync(file, "utf-8");

        // Parse the pack
        const pack = parsePack(content, file);

        // Validate pack-specific constraints
        const errors = validatePackConstraints(pack, file);

        if (errors.length > 0) {
          output(
            {
              valid: false,
              name: pack.envelope.name,
              version: pack.envelope.version,
              memories: pack.memories.length,
              errors,
            },
            fmt,
            () => {
              clack.log.error(
                `Pack '${pack.envelope.name}' v${pack.envelope.version} has ${errors.length} error(s):`,
              );
              for (const err of errors) {
                console.log(`  - ${err}`);
              }
            },
          );
          process.exit(1);
        }

        output(
          {
            valid: true,
            name: pack.envelope.name,
            version: pack.envelope.version,
            memories: pack.memories.length,
          },
          fmt,
          () => {
            clack.log.success(
              `Pack '${pack.envelope.name}' v${pack.envelope.version}: ${pack.memories.length} ${pack.memories.length === 1 ? "memory" : "memories"}, valid`,
            );
          },
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (fmt === "text") {
          clack.log.error(msg);
        } else {
          output({ valid: false, error: msg }, fmt, () => {});
        }
        process.exit(1);
      }
    });
}

// =============================================================================
// Install
// =============================================================================

function createPackInstallCommand(): Command {
  return new Command("install")
    .description("install a memory pack into the active engine")
    .argument("<file>", "pack YAML file to install")
    .option("--dry-run", "preview what would happen without making changes")
    .option("-y, --yes", "skip confirmation for stale memory deletion")
    .action(async (file: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      try {
        // Step 1: Read and validate
        const content = readFileSync(file, "utf-8");
        const pack = parsePack(content, file);
        const errors = validatePackConstraints(pack, file);

        if (errors.length > 0) {
          if (fmt === "text") {
            clack.log.error(
              `Pack validation failed with ${errors.length} error(s):`,
            );
            for (const err of errors) {
              console.log(`  - ${err}`);
            }
          } else {
            output({ error: "Validation failed", errors }, fmt, () => {});
          }
          process.exit(1);
        }

        const { envelope, memories } = pack;
        const packName = envelope.name;
        const packVersion = envelope.version;

        // Step 2: Connect to engine
        const engine = createClient({
          url: creds.server,
          apiKey: creds.apiKey,
        });

        // Step 3: Search for existing memories with same pack name
        const existing = await engine.memory.search({
          meta: { pack: { name: packName } },
          limit: 1000,
        });

        // Step 4: Identify stale memories (different version)
        const stale = existing.results.filter((m: Record<string, unknown>) => {
          const meta = m.meta as Record<string, unknown> | undefined;
          const packMeta = meta?.pack as Record<string, unknown> | undefined;
          return packMeta?.version !== packVersion;
        });

        // Step 5: Dry run report
        if (opts.dryRun) {
          output(
            {
              dryRun: true,
              pack: packName,
              version: packVersion,
              wouldInstall: memories.length,
              wouldDeleteStale: stale.length,
              existingTotal: existing.results.length,
            },
            fmt,
            () => {
              console.log(`  Pack: ${packName} v${packVersion}`);
              console.log(
                `  Would install: ${memories.length} ${memories.length === 1 ? "memory" : "memories"}`,
              );
              console.log(`  Would delete stale: ${stale.length}`);
              console.log(`  Existing: ${existing.results.length}`);
            },
          );
          return;
        }

        // Step 6: Delete stale memories
        if (stale.length > 0) {
          if (fmt === "text" && !opts.yes) {
            const confirmed = await clack.confirm({
              message: `Delete ${stale.length} stale ${stale.length === 1 ? "memory" : "memories"} from previous version?`,
              initialValue: true,
            });
            if (clack.isCancel(confirmed) || !confirmed) {
              clack.cancel("Cancelled.");
              process.exit(0);
            }
          }

          const spin = fmt === "text" ? clack.spinner() : null;
          spin?.start(
            `Deleting ${stale.length} stale ${stale.length === 1 ? "memory" : "memories"}...`,
          );

          for (const mem of stale) {
            await engine.memory.delete({ id: mem.id });
          }

          spin?.stop(
            `Deleted ${stale.length} stale ${stale.length === 1 ? "memory" : "memories"}`,
          );
        }

        // Step 7: Upsert new memories
        const spin = fmt === "text" ? clack.spinner() : null;
        spin?.start(
          `Installing ${memories.length} ${memories.length === 1 ? "memory" : "memories"}...`,
        );

        const createParams = memories.map((mem) => ({
          id: mem.id,
          content: mem.content,
          meta: {
            ...(mem.meta ?? {}),
            pack: { name: packName, version: packVersion },
          },
          tree: mem.tree ? `pack.${packName}.${mem.tree}` : `pack.${packName}`,
          ...(mem.temporal ? { temporal: mem.temporal } : {}),
        }));

        const result = await engine.memory.batchCreate({
          memories: createParams,
        });

        spin?.stop("Done");

        output(
          {
            pack: packName,
            version: packVersion,
            installed: result.ids.length,
            staleRemoved: stale.length,
          },
          fmt,
          () => {
            clack.log.success(
              `Installed pack '${packName}' v${packVersion}: ${result.ids.length} ${result.ids.length === 1 ? "memory" : "memories"}${stale.length > 0 ? ` (${stale.length} stale removed)` : ""}`,
            );
          },
        );
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

// =============================================================================
// List
// =============================================================================

function createPackListCommand(): Command {
  return new Command("list")
    .description("list installed packs in the active engine")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        // Search for all memories with meta.pack
        const result = await engine.memory.search({
          meta: { pack: {} },
          limit: 1000,
        });

        // Group by pack name
        const packs = new Map<
          string,
          { name: string; version: string; count: number }
        >();

        for (const mem of result.results) {
          const meta = mem.meta as Record<string, unknown> | undefined;
          const packMeta = meta?.pack as Record<string, unknown> | undefined;
          if (!packMeta?.name) continue;

          const name = packMeta.name as string;
          const version = (packMeta.version as string) ?? "unknown";

          const existing = packs.get(name);
          if (existing) {
            existing.count++;
          } else {
            packs.set(name, { name, version, count: 1 });
          }
        }

        const packList = Array.from(packs.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        );

        output({ packs: packList }, fmt, () => {
          if (packList.length === 0) {
            console.log("  No packs installed.");
            return;
          }
          for (const p of packList) {
            console.log(
              `  ${p.name.padEnd(25)} v${p.version.padEnd(10)} ${p.count} ${p.count === 1 ? "memory" : "memories"}`,
            );
          }
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

// =============================================================================
// Command Group
// =============================================================================

export function createPackCommand(): Command {
  const pack = new Command("pack").description("manage memory packs");
  pack.addCommand(createPackValidateCommand());
  pack.addCommand(createPackInstallCommand());
  pack.addCommand(createPackListCommand());
  return pack;
}
