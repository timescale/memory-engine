/**
 * `me import granola` — import Granola meeting notes & transcripts as memories.
 *
 * Granola stores its meetings behind its cloud API, but persists the signed-in
 * session locally (encrypted with Electron safeStorage). We read & decrypt that
 * session, refresh the access token, then pull every meeting and write one
 * memory per meeting under `<tree-root>.<document_id>` (default `~/granola`).
 * Idempotency is keyed on `(tree, name=document_id)`, so re-runs reconcile in
 * place via the server's content-aware `onConflict: "replace"`.
 *
 * macOS only for now (the local-credential read uses the login keychain).
 */

import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import {
  GranolaAuthError,
  readGranolaTokens,
} from "../importers/granola/auth.ts";
import {
  DEFAULT_GRANOLA_TREE_ROOT,
  type GranolaImportOptions,
  type GranolaImportResult,
  runGranolaImport,
} from "../importers/granola/index.ts";
import { createProgressReporter } from "../importers/index.ts";
import { getOutputFormat, output } from "../output.ts";
import {
  buildMemoryClient,
  handleError,
  requireAuth,
  requireSpace,
} from "../util.ts";
import { VALID_TREE_ROOT_RE } from "./import.ts";

/** Validate raw Commander opts into a typed import-option set (minus secrets). */
function buildGranolaOptions(
  opts: Record<string, unknown>,
): Omit<GranolaImportOptions, "refreshToken"> {
  const treeRoot =
    typeof opts.treeRoot === "string"
      ? opts.treeRoot
      : DEFAULT_GRANOLA_TREE_ROOT;
  if (!VALID_TREE_ROOT_RE.test(treeRoot)) {
    throw new Error(
      `Invalid --tree-root: '${treeRoot}'. Use ltree labels ([A-Za-z0-9_-]) ` +
        `separated by '.' or '/', with an optional leading '~' for your home.`,
    );
  }
  for (const field of ["since", "until"] as const) {
    const value = opts[field];
    if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
      throw new Error(
        `Invalid --${field}: '${value}' is not a valid ISO 8601 timestamp`,
      );
    }
  }
  return {
    granolaDir:
      typeof opts.granolaDir === "string" ? opts.granolaDir : undefined,
    treeRoot,
    since: typeof opts.since === "string" ? opts.since : undefined,
    until: typeof opts.until === "string" ? opts.until : undefined,
    // --include-invalid disables the default skip of non-meeting notes.
    skipInvalid: opts.includeInvalid !== true,
    // Transcripts are included by default; --no-transcript turns them off.
    includeTranscript: opts.transcript !== false,
    dryRun: opts.dryRun === true,
  };
}

/** Run one Granola import end-to-end and render the outcome. */
export async function runGranolaImportCommand(
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const creds = resolveCredentials(
    typeof globalOpts.server === "string" ? globalOpts.server : undefined,
  );
  const fmt = getOutputFormat(globalOpts);
  requireAuth(creds, fmt);
  requireSpace(creds, fmt);

  let opts: Omit<GranolaImportOptions, "refreshToken">;
  try {
    opts = buildGranolaOptions(rawOpts);
  } catch (error) {
    handleError(error, fmt);
  }

  // Read & decrypt Granola's local session before touching the network.
  let refreshToken: string;
  try {
    refreshToken = readGranolaTokens(opts.granolaDir).refresh_token;
  } catch (error) {
    if (error instanceof GranolaAuthError) {
      handleError(error, fmt);
    }
    throw error;
  }

  const engine = buildMemoryClient(creds);
  const progress =
    fmt === "text" ? createProgressReporter(process.stderr) : undefined;
  progress?.start();

  let result: GranolaImportResult;
  try {
    result = await runGranolaImport(
      engine,
      { ...opts, refreshToken },
      progress,
    );
  } catch (error) {
    progress?.stop();
    handleError(error, fmt);
  } finally {
    progress?.stop();
  }

  renderGranolaResult(result, fmt);
  if (result.failed > 0 && result.inserted === 0 && result.updated === 0) {
    process.exit(2);
  }
  if (result.failed > 0) process.exit(1);
}

/** Print the import result in text or structured format. */
function renderGranolaResult(
  result: GranolaImportResult,
  fmt: "text" | "json" | "yaml",
): void {
  output(result, fmt, () => {
    const verb = result.dryRun ? "Would import" : "Imported";
    clack.log.success(
      `${verb} ${result.inserted} new, ${result.updated} updated, ` +
        `${result.skipped} unchanged, ${result.failed} failed meetings ` +
        `into ${result.tree}`,
    );
    console.log(`  Scanned ${result.meetingsSeen} Granola meetings`);
    const skipTotal = Object.values(result.skipReasons).reduce(
      (a, b) => a + b,
      0,
    );
    if (skipTotal > 0) {
      const parts = Object.entries(result.skipReasons)
        .filter(([, n]) => n > 0)
        .map(([reason, n]) => `${reason}=${n}`);
      console.log(`  Meetings skipped: ${parts.join(", ")}`);
    }
    if (!result.includeTranscript) {
      console.log("  Transcripts omitted (--no-transcript)");
    }
    for (const e of result.errors) {
      console.log(`    ✗ ${e.documentId}: ${e.error}`);
    }
  });
}

/** `me import granola` subcommand factory. */
export function createGranolaImportCommand(): Command {
  return new Command("granola")
    .description("import Granola meeting notes and transcripts as memories")
    .option(
      "--tree-root <path>",
      `tree root under which '<document_id>' leaves are placed (default: ${DEFAULT_GRANOLA_TREE_ROOT})`,
    )
    .option(
      "--since <iso>",
      "only import meetings started at or after this timestamp",
    )
    .option(
      "--until <iso>",
      "only import meetings started at or before this timestamp",
    )
    .option(
      "--no-transcript",
      "import notes only, skipping the full meeting transcript",
    )
    .option(
      "--include-invalid",
      "include notes Granola did not flag as valid meetings",
    )
    .option(
      "--granola-dir <dir>",
      "override the Granola application-support directory",
    )
    .option(
      "--dry-run",
      "fetch and report what would be imported without writing",
    )
    .action(async (opts, cmdRef) => {
      const globalOpts = cmdRef.optsWithGlobals();
      await runGranolaImportCommand(opts, globalOpts);
    });
}
