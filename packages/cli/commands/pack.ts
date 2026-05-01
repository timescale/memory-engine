/**
 * me pack — memory pack management commands.
 *
 * - me pack validate <file>: Validate a pack file locally
 * - me pack install <file>: Install a memory pack into the active engine
 * - me pack list: List installed packs in the active engine
 */

import { readFileSync } from "node:fs";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { batchCreateChunked } from "../chunk.ts";
import { createClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
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
          // Predict skips: rows that survive the stale-deletion (i.e. already
          // at the target version) will trigger `ON CONFLICT DO NOTHING` for
          // any matching ids in the install set. We can't predict collisions
          // with non-pack memories without extra lookups, so the actual
          // install may surface additional `skippedConflict` warnings.
          const survivingIds = new Set(
            existing.results
              .filter((m) => {
                const meta = m.meta as Record<string, unknown> | undefined;
                const packMeta = meta?.pack as
                  | Record<string, unknown>
                  | undefined;
                return packMeta?.version === packVersion;
              })
              .map((m) => m.id),
          );
          const wouldSkipIdempotent = memories.filter(
            (m) => m.id && survivingIds.has(m.id),
          ).length;
          const wouldInstall = memories.length - wouldSkipIdempotent;

          output(
            {
              dryRun: true,
              pack: packName,
              version: packVersion,
              wouldInstall,
              wouldSkipIdempotent,
              wouldDeleteStale: stale.length,
              existingTotal: existing.results.length,
            },
            fmt,
            () => {
              console.log(`  Pack: ${packName} v${packVersion}`);
              console.log(
                `  Would install: ${wouldInstall} ${wouldInstall === 1 ? "memory" : "memories"}`,
              );
              if (wouldSkipIdempotent > 0) {
                console.log(
                  `  Would skip (already present): ${wouldSkipIdempotent}`,
                );
              }
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

        // Chunked batch create — large packs are sliced under the
        // server's request-body limit, and a single failed chunk doesn't
        // take down its siblings (re-running install will self-heal).
        const {
          insertedIds,
          failedIds,
          errors: chunkErrors,
        } = await batchCreateChunked(engine, createParams);

        spin?.stop("Done");

        // Post-#64 `batchCreate` returns only ids it actually inserted —
        // conflicting ids are silently skipped. Classify the skips so the
        // user sees benign re-installs vs real id collisions, excluding
        // failed-chunk ids (those never reached the server).
        const requestedIds = createParams
          .map((p) => p.id)
          .filter((x): x is string => typeof x === "string");
        const { idempotent, conflict } = classifySkips({
          requestedIds,
          insertedIds,
          failedIds,
          existing: existing.results,
          packName,
          packVersion,
        });

        const installed = insertedIds.length;
        const skippedIdempotent = idempotent.length;
        const skippedConflict = conflict.length;
        const skipped = skippedIdempotent + skippedConflict;
        const failed = failedIds.length;

        const jsonOut: Record<string, unknown> = {
          pack: packName,
          version: packVersion,
          installed,
          staleRemoved: stale.length,
          skipped,
          skippedIdempotent,
          skippedConflict,
          failed,
        };
        if (skippedConflict > 0) {
          jsonOut.skippedConflictIds = conflict;
        }
        if (failed > 0) {
          jsonOut.failedIds = failedIds;
          jsonOut.errors = chunkErrors;
        }

        output(jsonOut, fmt, () => {
          // Pure idempotent re-install — distinct success line.
          if (
            installed === 0 &&
            stale.length === 0 &&
            skippedIdempotent > 0 &&
            skippedConflict === 0 &&
            failed === 0
          ) {
            clack.log.success(
              `Pack '${packName}' v${packVersion} already installed (${skippedIdempotent} ${skippedIdempotent === 1 ? "memory" : "memories"} present, no changes)`,
            );
          } else {
            const lines: string[] = [];
            lines.push(
              `Installed pack '${packName}' v${packVersion}: ${installed} ${installed === 1 ? "memory" : "memories"}`,
            );
            if (stale.length > 0) {
              lines.push(
                `    └ ${stale.length} stale removed (from previous version)`,
              );
            }
            if (skippedIdempotent > 0) {
              lines.push(
                `    └ ${skippedIdempotent} already present (skipped)`,
              );
            }
            if (failed > 0) {
              lines.push(
                `    └ ${failed} failed (chunk error — re-run to retry)`,
              );
            }
            clack.log.success(lines.join("\n"));
          }

          if (skippedConflict > 0) {
            const idsList = conflict.map((id) => `    ${id}`).join("\n");
            const noun = skippedConflict === 1 ? "memory" : "memories";
            const verb = skippedConflict === 1 ? "collides" : "collide";
            clack.log.warn(
              `${skippedConflict} ${noun} not installed — id ${verb} with existing non-pack ${noun}:\n${idsList}\n  Inspect with: me memory get <id>`,
            );
          }

          if (failed > 0) {
            const errLines = chunkErrors
              .map(
                (e) =>
                  `    chunk ${e.chunkIndex} (${e.itemCount} items): ${e.error}`,
              )
              .join("\n");
            clack.log.error(
              `${failed} ${failed === 1 ? "memory" : "memories"} failed before reaching the server:\n${errLines}\n  Re-run \`me pack install\` to retry — already-installed memories will be skipped.`,
            );
          }
        });
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
    .alias("ls")
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
          table(
            ["name", "version", "memories"],
            packList.map((p) => [p.name, p.version, String(p.count)]),
          );
        });
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

// =============================================================================
// Skip classification (post-#64 batchCreate semantics)
// =============================================================================

/**
 * `engine.memory.batchCreate` uses `ON CONFLICT (id) DO NOTHING` server-side,
 * so the returned `ids` array can be shorter than the request when conflicts
 * occur. For pack install, ids that didn't land fall into three buckets:
 *
 * - **idempotent**: the row is already present and tagged with this pack
 *   name + version (a benign re-install of the same version)
 * - **conflict**:   the id is held by something else — a different pack,
 *   a different version, or a non-pack memory the user wrote themselves.
 *   Surfaced as a warning so a real id collision isn't silently masked.
 * - **failed (excluded here)**: the id was in a chunk that errored before
 *   reaching the server. Callers pass these via `failedIds` so they don't
 *   get mis-classified as conflicts; they're tracked separately under
 *   the `failed` bucket in the install output.
 *
 * Pure function exported for unit testing.
 */
export function classifySkips(args: {
  requestedIds: string[];
  insertedIds: string[];
  /**
   * Ids that were submitted but never reached the server because their
   * containing chunk errored. Optional — if omitted, treated as empty.
   */
  failedIds?: string[];
  existing: ReadonlyArray<{ id: string; meta?: unknown }>;
  packName: string;
  packVersion: string;
}): { idempotent: string[]; conflict: string[] } {
  const inserted = new Set(args.insertedIds);
  const failed = new Set(args.failedIds ?? []);
  const existingById = new Map<string, unknown>(
    args.existing.map((m) => [m.id, m.meta]),
  );
  const idempotent: string[] = [];
  const conflict: string[] = [];

  for (const id of args.requestedIds) {
    if (inserted.has(id) || failed.has(id)) continue;

    const meta = existingById.get(id);
    const packMeta =
      meta && typeof meta === "object"
        ? (meta as Record<string, unknown>).pack
        : undefined;
    const pm =
      packMeta && typeof packMeta === "object"
        ? (packMeta as Record<string, unknown>)
        : undefined;

    if (pm?.name === args.packName && pm?.version === args.packVersion) {
      idempotent.push(id);
    } else {
      conflict.push(id);
    }
  }
  return { idempotent, conflict };
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
