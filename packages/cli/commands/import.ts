/**
 * Shared helpers for the per-agent `import` subcommands.
 *
 * Each agent command group (`me claude`, `me codex`, `me opencode`) adds its
 * own `import` subcommand via `buildAgentImportSubcommand`. Each source-native
 * message becomes one memory, stored under
 * `<tree-root>.<project_slug>.<sessions-node-name>`.
 *
 * Shared flags across every `import` subcommand:
 *   --source <dir>           override default source directory
 *   --project <cwd>          only import sessions with this cwd (or a child)
 *   --since <iso>            only sessions started at/after this timestamp
 *   --until <iso>            only sessions started at/before this timestamp
 *   --tree-root <path>       tree root under which `<slug>.<sessions-node-name>`
 *                            nodes are placed (default: projects)
 *   --sessions-node-name     per-project node name for imported agent
 *                            sessions (default: agent_sessions)
 *   --full-transcript        include reasoning, tool calls, tool results
 *   --include-sidechains     (claude only) include subagent sessions
 *   --include-temp-cwd       include sessions whose cwd is /tmp, /private/var/...
 *   --include-trivial        include sessions with fewer than 2 user messages
 *   --dry-run                parse and report without writing
 *   -v, --verbose            per-session progress lines
 */
import * as clack from "@clack/prompts";
import { createClient } from "@memory.build/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import {
  createProgressReporter,
  type Importer,
  type ImportResult,
  runImport,
  type WriteOptions,
} from "../importers/index.ts";
import type { ImporterOptions } from "../importers/types.ts";
import { getOutputFormat, output } from "../output.ts";
import { handleError, requireEngine, requireSession } from "../util.ts";

const DEFAULT_TREE_ROOT = "projects";
const DEFAULT_SESSIONS_NODE_NAME = "agent_sessions";
const VALID_TREE_ROOT_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const VALID_TREE_LABEL_RE = /^[a-z0-9_]+$/;

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
      `tree root under which '<slug>.<sessions-node-name>' nodes are placed (default: ${DEFAULT_TREE_ROOT})`,
    )
    .option(
      "--sessions-node-name <name>",
      `per-project node name for imported agent sessions (default: ${DEFAULT_SESSIONS_NODE_NAME})`,
    )
    .option(
      "--full-transcript",
      "include reasoning, tool calls, and tool results as additional message memories",
    )
    .option(
      "--include-temp-cwd",
      "include sessions whose cwd is a system temp directory",
    )
    .option(
      "--include-trivial",
      "include sessions with fewer than 2 user messages (one-shot queries, warm-up pings)",
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
export function buildOptions(opts: Record<string, unknown>): {
  importer: ImporterOptions;
  write: WriteOptions;
} {
  const treeRoot =
    typeof opts.treeRoot === "string" ? opts.treeRoot : DEFAULT_TREE_ROOT;
  const sessionsNodeName =
    typeof opts.sessionsNodeName === "string"
      ? opts.sessionsNodeName
      : DEFAULT_SESSIONS_NODE_NAME;
  if (!VALID_TREE_ROOT_RE.test(treeRoot)) {
    throw new Error(
      `Invalid --tree-root: '${treeRoot}'. Must match [a-z0-9_]+(\\.[a-z0-9_]+)*`,
    );
  }
  if (!VALID_TREE_LABEL_RE.test(sessionsNodeName)) {
    throw new Error(
      `Invalid --sessions-node-name: '${sessionsNodeName}'. Must match [a-z0-9_]+`,
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
    sessionsNodeName,
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

/** Print the import result in text or structured format. */
function renderResult(
  result: ImportResult,
  tool: string,
  write: WriteOptions,
  fmt: "text" | "json" | "yaml",
): void {
  const skippedBreakdown = result.discovery.skipped;

  const failedSessions = result.outcomes
    .filter((o) => o.failed > 0)
    .map((o) => ({
      sessionId: o.sessionId,
      title: o.title,
      failed: o.failed,
      inserted: o.inserted,
      updated: o.updated,
      skipped: o.skipped,
      sourceFile: o.sourceFile,
      errors: o.errors,
    }));

  const structured = {
    tool,
    dryRun: write.dryRun,
    treeRoot: write.treeRoot,
    sessionsNodeName: write.sessionsNodeName,
    fullTranscript: write.fullTranscript,
    totalFiles: result.discovery.totalFiles,
    sessionsProcessed: result.sessionsProcessed,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
    sessionSkipReasons: skippedBreakdown,
    parseErrors: result.discovery.errors,
    failedSessions,
    slugCollisions: result.slugCollisions,
  };

  output(structured, fmt, () => {
    const verb = write.dryRun ? "Would import" : "Imported";
    clack.log.success(
      `${verb} ${result.inserted} new, ${result.updated} updated, ` +
        `${result.skipped} skipped, ${result.failed} failed messages ` +
        `across ${result.sessionsProcessed} sessions for ${tool}`,
    );
    console.log(`  Scanned ${result.discovery.totalFiles} session files`);
    const sessionSkipTotal = Object.values(skippedBreakdown).reduce(
      (a, b) => a + b,
      0,
    );
    if (sessionSkipTotal > 0) {
      const parts = Object.entries(skippedBreakdown)
        .filter(([, n]) => n > 0)
        .map(([reason, n]) => `${reason}=${n}`);
      console.log(`  Sessions skipped: ${parts.join(", ")}`);
    }
    if (result.discovery.errors.length > 0) {
      console.log(`  Parse errors: ${result.discovery.errors.length}`);
      if (write.verbose) {
        for (const { source, error } of result.discovery.errors) {
          console.log(`    ${source}: ${error}`);
        }
      }
    }
    if (failedSessions.length > 0) {
      console.log(`  Failed (${failedSessions.length}):`);
      for (const f of failedSessions) {
        const short = f.sessionId.slice(0, 8);
        console.log(`    ✗ ${short} ${f.title} (${f.failed} message(s))`);
        if (f.sourceFile) console.log(`        source: ${f.sourceFile}`);
        for (const err of f.errors) {
          console.log(`        ${err.messageId}: ${err.error}`);
        }
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
 * Build an `import` subcommand bound to a specific importer. Each agent
 * command group (`me claude`, `me codex`, `me opencode`) calls this to add
 * its own `import` subcommand.
 */
export function buildAgentImportSubcommand(
  description: string,
  importer: Importer,
  includeSidechainsFlag = false,
): Command {
  const cmd = new Command("import").description(description);
  addCommonOptions(cmd, includeSidechainsFlag);
  cmd.action(async (opts, cmdRef) => {
    const globalOpts = cmdRef.optsWithGlobals();
    await runAndRender(importer, opts, globalOpts);
  });
  return cmd;
}
