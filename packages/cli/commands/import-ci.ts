/**
 * `me import ci` — the CI import orchestrator: run the project's configured
 * imports (git history, then docs) from the repo toplevel with
 * CI-appropriate defaults.
 *
 * This is the one command the scaffolded GitHub workflow calls
 * (`me project ci` writes the workflow; see CI_IMPORT_DESIGN.md). Keeping the
 * orchestration here — not in workflow YAML — means behavior ships with the
 * CLI, the committed workflow stays frozen, and a developer can preview
 * exactly what CI will do with `me import ci --dry-run` locally.
 *
 * Phases (each is the existing importer, unchanged semantics):
 *   1. git   — `me import git` on HEAD: incremental via the server-side
 *              high-water lookup; the first run is automatically a
 *              full-history backfill.
 *   2. docs  — `me import docs` from the repo toplevel with the default
 *              markdown globs and PRUNE ON: the CI run is the authoritative
 *              full-corpus walk, so deleted/renamed docs are removed. A repo
 *              with no matching docs skips the phase cleanly (skipIfEmpty).
 *
 * The optional `.me/config.yaml` `import:` block shapes the run — phase
 * toggles (`git`/`docs`) and docs scoping (`docs_include`/`docs_exclude`).
 * Targeting (server/space/tree) resolves exactly as the underlying importers
 * resolve it: from the repo's `.me`, with the `ME_API_KEY` bearer as the
 * identity (in CI, a service-account key).
 *
 * Phases are fail-fast: each sub-runner renders its own summary and exits
 * non-zero on failure, so a broken git phase stops the run before docs and
 * the workflow goes red — loud failure is the point (the retired post-commit
 * hook rotted silently).
 *
 * Determinism rule: nothing here may stamp per-run metadata (run id,
 * timestamp, actor) into memories — replace-no-op idempotency of both
 * importers depends on deterministic meta.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { SlugRegistry } from "../importers/slug.ts";
import { getOutputFormat } from "../output.ts";
import { discoverProjectConfig } from "../project-config.ts";
import { handleError } from "../util.ts";
import { runDocsImport } from "./import-docs.ts";
import { runGitImport } from "./import-git.ts";

/** Run the orchestrated CI import end-to-end (see module doc). */
export async function runCiImport(
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const fmt = getOutputFormat(globalOpts);
  // Two phases render two structured documents — not one parseable --json
  // output — so structured formats are rejected up front rather than
  // emitting concatenated JSON.
  if (fmt !== "text") {
    handleError(
      new Error(
        "me import ci renders per-phase text output; --json/--yaml are not supported. " +
          "Run `me import git` / `me import docs` separately for structured output.",
      ),
      fmt,
    );
  }
  const dryRun = rawOpts.dryRun === true;
  const verbose = rawOpts.verbose === true;

  // Anchor everything at the repo toplevel: docs tree slots and the prune
  // scope derive from the import root, so the orchestrated run must not
  // depend on where inside the repo it was invoked.
  const { gitRoot } = await new SlugRegistry().resolve(process.cwd());
  if (gitRoot === undefined) {
    handleError(
      new Error(
        "me import ci must run inside a git repository — its imports anchor at the repo toplevel",
      ),
      fmt,
    );
  }

  // The repo's own `.me` (from the toplevel, so the anchor matches the
  // phases' per-target resolution). A malformed config is fatal here — CI
  // must go red, not half-run.
  let importCfg: {
    git?: boolean;
    docs?: boolean;
    docs_include?: string[];
    docs_exclude?: string[];
  };
  try {
    importCfg = discoverProjectConfig(gitRoot)?.import ?? {};
  } catch (error) {
    handleError(error, fmt);
  }

  if (importCfg.git !== false) {
    clack.log.step("Git history");
    await runGitImport({ dryRun, verbose }, globalOpts, gitRoot);
  } else {
    clack.log.info("Git history phase disabled (.me import.git: false)");
  }

  if (importCfg.docs !== false) {
    clack.log.step("Docs");
    await runDocsImport(
      gitRoot,
      {
        include: importCfg.docs_include,
        exclude: importCfg.docs_exclude,
        prune: true,
        skipIfEmpty: true,
        dryRun,
        verbose,
      },
      globalOpts,
    );
  } else {
    clack.log.info("Docs phase disabled (.me import.docs: false)");
  }
}

/** `me import ci` subcommand factory. */
export function createCiImportCommand(): Command {
  return new Command("ci")
    .description(
      "run the project's configured imports (git history + docs) from the repo toplevel — the command CI calls",
    )
    .option(
      "--dry-run",
      "report what each phase would import/prune without writing",
    )
    .option("-v, --verbose", "per-item progress output")
    .action(async (opts, cmdRef) => {
      const globalOpts = cmdRef.optsWithGlobals();
      await runCiImport(opts, globalOpts);
    });
}
