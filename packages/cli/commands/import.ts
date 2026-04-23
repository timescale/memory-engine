/**
 * me import — import agent conversations from local CLI agents.
 *
 * Subcommands:
 *   me import claude    — from ~/.claude/projects/*.jsonl
 *   me import codex     — from ~/.codex/sessions + archived_sessions
 *   me import opencode  — from ~/.local/share/opencode/storage
 *
 * Shared flags across all three subcommands:
 *   --source <dir>           override default source directory
 *   --project <cwd>          only import sessions with this cwd (or a child)
 *   --since <iso>            only sessions started at/after this timestamp
 *   --until <iso>            only sessions started at/before this timestamp
 *   --tree-root <path>       tree root to store memories under
 *                            (default: agent_conversations)
 *   --flat                   store all sessions directly under tree-root
 *                            (no project subnode)
 *   --full-transcript        include reasoning, tool calls, tool results
 *   --include-sidechains     (claude only) include subagent sessions
 *   --include-temp-cwd       include sessions whose cwd is /tmp, /private/var/...
 *   --include-trivial        include sessions with fewer than 2 user turns
 *   --dry-run                parse and report without writing
 *   -v, --verbose            per-session progress lines
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory.build/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { claudeImporter } from "../importers/claude.ts";
import { codexImporter } from "../importers/codex.ts";
import {
  createProgressReporter,
  type Importer,
  type ImportResult,
  runImport,
  type WriteOptions,
} from "../importers/index.ts";
import { opencodeImporter } from "../importers/opencode.ts";
import type { ImporterOptions } from "../importers/types.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";

const DEFAULT_TREE_ROOT = "agent_conversations";
const VALID_TREE_ROOT_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/** Build a Commander option set shared by every subcommand. */
function addCommonOptions(
  cmd: Command,
  includeSidechainsFlag: boolean,
): Command {
  cmd
    .option("--source <dir>", "override default source directory")
    .option(
      "--project <cwd>",
      "only import sessions with this cwd (or a subdirectory of it)",
    )
    .option(
      "--since <iso>",
      "only import sessions started at or after this timestamp",
    )
    .option(
      "--until <iso>",
      "only import sessions started at or before this timestamp",
    )
    .option(
      "--tree-root <path>",
      `tree root to store memories under (default: ${DEFAULT_TREE_ROOT})`,
    )
    .option(
      "--flat",
      "store all sessions directly under the tree root (no project subnode)",
    )
    .option(
      "--full-transcript",
      "include reasoning, tool calls, and tool results in memory content",
    )
    .option(
      "--include-temp-cwd",
      "include sessions whose cwd is a system temp directory",
    )
    .option(
      "--include-trivial",
      "include sessions with fewer than 2 user turns (one-shot queries, warm-up pings)",
    )
    .option(
      "--dry-run",
      "parse and report what would be imported without writing",
    )
    .option("-v, --verbose", "per-session progress output");
  if (includeSidechainsFlag) {
    cmd.option(
      "--include-sidechains",
      "include subagent sessions (agent-*.jsonl in Claude)",
    );
  }
  return cmd;
}

/**
 * Assemble importer + write options from Commander parsed opts.
 * Validates --tree-root syntax and the ISO filter bounds.
 */
function buildOptions(opts: Record<string, unknown>): {
  importer: ImporterOptions;
  write: WriteOptions;
} {
  const treeRoot =
    typeof opts.treeRoot === "string" ? opts.treeRoot : DEFAULT_TREE_ROOT;
  if (!VALID_TREE_ROOT_RE.test(treeRoot)) {
    throw new Error(
      `Invalid --tree-root: '${treeRoot}'. Must match [a-z0-9_]+(\\.[a-z0-9_]+)*`,
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

  const importer: ImporterOptions = {
    source: typeof opts.source === "string" ? opts.source : undefined,
    projectFilter: typeof opts.project === "string" ? opts.project : undefined,
    since: typeof opts.since === "string" ? opts.since : undefined,
    until: typeof opts.until === "string" ? opts.until : undefined,
    fullTranscript: opts.fullTranscript === true,
    includeSidechains: opts.includeSidechains === true,
    includeTempCwd: opts.includeTempCwd === true,
    includeTrivial: opts.includeTrivial === true,
  };
  const write: WriteOptions = {
    treeRoot,
    flat: opts.flat === true,
    fullTranscript: opts.fullTranscript === true,
    dryRun: opts.dryRun === true,
    verbose: opts.verbose === true,
  };
  return { importer, write };
}

/**
 * Run one importer end-to-end and render the outcome in the selected format.
 */
async function runAndRender(
  importer: Importer,
  opts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const creds = resolveCredentials(
    typeof globalOpts.server === "string" ? globalOpts.server : undefined,
  );
  const fmt = getOutputFormat(globalOpts);
  requireSession(creds, fmt);
  requireEngine(creds, fmt);

  let config: ReturnType<typeof buildOptions>;
  try {
    config = buildOptions(opts);
  } catch (error) {
    handleError(error, fmt);
  }

  const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

  if (fmt === "text" && config.write.verbose) {
    const sourceNote = config.importer.source ?? importer.defaultSource;
    clack.log.info(
      `Importing ${importer.tool} sessions from ${sourceNote}${
        config.write.dryRun ? " (dry run)" : ""
      }`,
    );
  }

  const progress =
    fmt === "text" ? createProgressReporter(process.stderr) : undefined;
  progress?.start();

  let result: ImportResult;
  try {
    result = await runImport(
      engine,
      importer,
      config.importer,
      config.write,
      progress,
    );
  } catch (error) {
    progress?.stop();
    handleError(error, fmt);
  } finally {
    progress?.stop();
  }

  renderResult(result, importer.tool, config.write, fmt);
  if (result.failed > 0 && result.inserted === 0 && result.updated === 0) {
    process.exit(2);
  }
  if (result.failed > 0) process.exit(1);
}

/**
 * Print the import result in text or structured format.
 */
function renderResult(
  result: ImportResult,
  tool: string,
  write: WriteOptions,
  fmt: "text" | "json" | "yaml",
): void {
  const skippedBreakdown = result.discovery.skipped;
  const skippedTotal =
    Object.values(skippedBreakdown).reduce((a, b) => a + b, 0) + result.skipped;

  const failures = result.outcomes
    .filter((o) => o.action === "failed")
    .map((o) => ({
      sessionId: o.sessionId,
      memoryId: o.memoryId,
      title: o.title,
      reason: o.reason ?? "unknown error",
      sourceFile: o.sourceFile,
    }));

  const structured = {
    tool,
    dryRun: write.dryRun,
    treeRoot: write.treeRoot,
    flat: write.flat,
    fullTranscript: write.fullTranscript,
    totalFiles: result.discovery.totalFiles,
    inserted: result.inserted,
    updated: result.updated,
    skipped: skippedTotal,
    failed: result.failed,
    skippedReasons: skippedBreakdown,
    parseErrors: result.discovery.errors,
    failures,
    slugCollisions: result.slugCollisions,
  };

  output(structured, fmt, () => {
    const verb = write.dryRun ? "Would import" : "Imported";
    clack.log.success(
      `${verb} ${result.inserted} new, ${result.updated} updated for ${tool} (${result.skipped} skipped post-fetch, ${result.failed} failed)`,
    );
    console.log(`  Scanned ${result.discovery.totalFiles} session files`);
    if (skippedTotal > 0) {
      const parts = Object.entries(skippedBreakdown)
        .filter(([, n]) => n > 0)
        .map(([reason, n]) => `${reason}=${n}`);
      if (result.skipped > 0) parts.push(`unchanged=${result.skipped}`);
      if (parts.length > 0) console.log(`  Skipped: ${parts.join(", ")}`);
    }
    if (result.discovery.errors.length > 0) {
      console.log(`  Parse errors: ${result.discovery.errors.length}`);
      if (write.verbose) {
        for (const { source, error } of result.discovery.errors) {
          console.log(`    ${source}: ${error}`);
        }
      }
    }
    if (failures.length > 0) {
      console.log(`  Failed (${failures.length}):`);
      for (const f of failures) {
        const short = f.sessionId.slice(0, 8);
        console.log(`    ✗ ${short} ${f.title}`);
        console.log(`        ${f.reason}`);
        if (f.sourceFile) console.log(`        source: ${f.sourceFile}`);
      }
    }
    if (result.slugCollisions.length > 0 && write.verbose) {
      console.log(
        `  Slug collisions resolved: ${result.slugCollisions.length}`,
      );
      for (const c of result.slugCollisions) {
        console.log(`    ${c.baseSlug}: ${c.cwds.join(", ")}`);
      }
    }
  });
}

/**
 * Build a subcommand that runs a specific importer.
 */
function buildImporterCommand(
  name: string,
  description: string,
  importer: Importer,
  includeSidechainsFlag = false,
): Command {
  const cmd = new Command(name).description(description);
  addCommonOptions(cmd, includeSidechainsFlag);
  cmd.action(async (opts, cmdRef) => {
    const globalOpts = cmdRef.optsWithGlobals();
    await runAndRender(importer, opts, globalOpts);
  });
  return cmd;
}

export function createImportCommand(): Command {
  const group = new Command("import").description(
    "import agent conversations into the active engine",
  );
  group.addCommand(
    buildImporterCommand(
      "claude",
      "import Claude Code sessions from ~/.claude/projects",
      claudeImporter,
      true,
    ),
  );
  group.addCommand(
    buildImporterCommand(
      "codex",
      "import Codex sessions from ~/.codex/sessions and archived_sessions",
      codexImporter,
    ),
  );
  group.addCommand(
    buildImporterCommand(
      "opencode",
      "import OpenCode sessions from ~/.local/share/opencode/storage",
      opencodeImporter,
    ),
  );
  return group;
}
