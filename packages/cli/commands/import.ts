/**
 * Shared helpers for the agent-session import subcommands.
 *
 * Each agent importer is exposed twice: canonically under the import group
 * (`me import claude|codex|opencode`) and as an alias under its agent command
 * group (`me claude import`, …) — both built from the same per-tool factory
 * (`createClaudeImportCommand`, …). Each source-native message becomes one
 * memory, stored under `<tree-root>.<project_slug>.<sessions-node-name>` — or,
 * for a `--project`-scoped run whose project pins a `.me/config.yaml` `tree`,
 * directly under `<tree>.<sessions-node-name>` (no slug), matching the live
 * capture hook.
 *
 * Shared flags across every agent import subcommand:
 *   --source <dir>           override default source directory / DB
 *   --project <cwd>          only import sessions with this cwd (or a child)
 *   --since <iso>            only sessions started at/after this timestamp
 *   --until <iso>            only sessions started at/before this timestamp
 *   --tree-root <path>       tree root under which `<slug>.<sessions-node-name>`
 *                            nodes are placed (default: the `.me` tree for a
 *                            --project run, else the private `~/projects`)
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
import { Command } from "commander";
import type { MemoryClient } from "../client.ts";
import {
  type ResolvedCredentials,
  resolveCredentials,
  resolveCredentialsFor,
} from "../credentials.ts";
import { claudeImporter } from "../importers/claude.ts";
import { codexImporter } from "../importers/codex.ts";
import {
  createProgressReporter,
  DEFAULT_PRIVATE_TREE_ROOT,
  DEFAULT_SESSIONS_NODE_NAME,
  type Importer,
  type ImportResult,
  runImport,
  type SessionRouteDecision,
  type SessionRouter,
  type WriteOptions,
} from "../importers/index.ts";
import { opencodeImporter } from "../importers/opencode.ts";
import type { ImporterOptions } from "../importers/types.ts";
import { getOutputFormat, output } from "../output.ts";
import {
  discoverProjectConfig,
  VALID_TREE_PATH_RE,
} from "../project-config.ts";
import {
  buildMemoryClient,
  handleError,
  requireAuth,
  requireSpace,
  shellTildeExpansionHint,
} from "../util.ts";

// Default capture layout (~/projects.<slug>.agent_sessions — private) lives in the
// importers module so `me import <tool>` and the Claude Code hook share one source.
// User-facing tree-path input shares the strict client-side gate with the `.me`
// `tree` / global `tree_root` (see VALID_TREE_PATH_RE): labels [A-Za-z0-9_-],
// `.`/`/` separators, optional leading `~` (home) or `/`. The server still
// normalizes + authoritatively validates.
export const VALID_TREE_ROOT_RE = VALID_TREE_PATH_RE;
const VALID_TREE_LABEL_RE = /^[a-z0-9_]+$/;

/** Build a Commander option set shared by every subcommand. */
function addCommonOptions(
  cmd: Command,
  includeSidechainsFlag: boolean,
): Command {
  cmd
    .option("--source <dir>", "override default source directory or database")
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
      `tree root under which '<slug>.<sessions-node-name>' nodes are placed (default: the .me/config.yaml tree for a --project run, else ${DEFAULT_PRIVATE_TREE_ROOT} — private)`,
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
 *
 * This computes only the RUN-LEVEL parent (`treeRoot`); per-session trees
 * come from the router (`createSessionRouter`), which resolves each session's
 * own project `.me` — so `write.tree` is left unset here and superseded per
 * session. The parent, highest-first: an explicit `--tree-root` (a slug-free
 * parent — each project's slug is appended under it; it also overrides every
 * project's `.me` tree, via the router) > the machine-wide `tree_root` config
 * override > the private `~/projects`.
 */
export function buildOptions(
  opts: Record<string, unknown>,
  creds?: { treeRoot?: string },
): {
  importer: ImporterOptions;
  write: WriteOptions;
} {
  const explicitTreeRoot = typeof opts.treeRoot === "string";
  const treeRoot = explicitTreeRoot
    ? (opts.treeRoot as string)
    : (creds?.treeRoot ?? DEFAULT_PRIVATE_TREE_ROOT);
  const sessionsNodeName =
    typeof opts.sessionsNodeName === "string"
      ? opts.sessionsNodeName
      : DEFAULT_SESSIONS_NODE_NAME;
  if (explicitTreeRoot) {
    const hint = shellTildeExpansionHint(treeRoot);
    if (hint) {
      throw new Error(
        `Invalid --tree-root: '${treeRoot}' looks like your shell expanded '~'.
${hint}`,
      );
    }
  }
  if (!VALID_TREE_ROOT_RE.test(treeRoot)) {
    throw new Error(
      `Invalid --tree-root: '${treeRoot}'. Use ltree labels ([A-Za-z0-9_-]) separated by '.' or '/', with an optional leading '~' for your home.`,
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
 * Build the per-session router for a bulk import: each session's project is
 * resolved through the REAL local resolution stack — `discoverProjectConfig`
 * from the session's own cwd, passed explicitly to `resolveCredentialsFor` —
 * so a sweep mirrors the live hook exactly: per-project server
 * (whitelist-gated), space, tree, and even the `ME_AS_AGENT=.me` sentinel,
 * with the documented flag/env precedence intact because it IS the same code
 * path a local run uses (the `--server` flag reaches it via the preAction
 * seed). Decisions (including the client) are memoized per cwd; clients are
 * cheap stateless wrappers — token/refresh state lives at module level keyed
 * by server — so distinct projects resolving to the same target just build
 * equivalent ones.
 *
 * Per-project failures never kill the sweep — best-effort like the hook,
 * they become skip tallies (`discovery.skipped[reason]`):
 *   - `project_config_error`      — resolving the project threw: a malformed
 *                                   `.me`, an untrusted `server` (the same
 *                                   credential-safety gate a local run
 *                                   applies), a `.me` agent sentinel with no
 *                                   project agent, … (the message is carried
 *                                   as the skip detail for verbose output);
 *   - `no_credentials_for_server` — no api key and no login session for the
 *                                   project's server;
 *   - `no_space_for_project`      — no space resolvable there.
 */
export function createSessionRouter(opts: {
  /** An explicit `--tree-root`: wins over every project's `.me` tree. */
  explicitTreeRoot?: string;
  /** The run-level default route (sessions with no cwd / no `.me`). */
  base: { creds: ResolvedCredentials; engine: MemoryClient };
  /** Injectable client factory (tests). */
  buildClient?: (
    creds: ResolvedCredentials & { activeSpace: string },
  ) => MemoryClient;
}): SessionRouter {
  const buildClient = opts.buildClient ?? buildMemoryClient;
  const treeRootOf = (creds: ResolvedCredentials): string =>
    opts.explicitTreeRoot ?? creds.treeRoot ?? DEFAULT_PRIVATE_TREE_ROOT;

  const routeByCwd = new Map<string, SessionRouteDecision>();
  const base: SessionRouteDecision = {
    route: {
      engine: opts.base.engine,
      tree: undefined,
      treeRoot: treeRootOf(opts.base.creds),
    },
  };

  function computeRoute(cwd: string): SessionRouteDecision {
    try {
      // The session project's `.me`, from ITS cwd, passed EXPLICITLY —
      // `resolveCredentialsFor(undefined)` means "no project config", so the
      // sweep runner's own project can never leak in.
      const creds = resolveCredentialsFor(discoverProjectConfig(cwd));

      if (!creds.apiKey && !creds.loggedIn) {
        return { skip: "no_credentials_for_server" };
      }
      const space = creds.activeSpace;
      if (!space) return { skip: "no_space_for_project" };

      // Always a client from THIS project's creds — the client carries the
      // identity (asAgent header), which the `.me` agent sentinel makes
      // per-project, so reusing another target's client could write as the
      // wrong principal. Clients are cheap stateless wrappers, and the
      // per-cwd memo above prevents rebuilds for the hot case of many
      // sessions from one project.
      return {
        route: {
          engine: buildClient({ ...creds, activeSpace: space }),
          tree: opts.explicitTreeRoot ? undefined : creds.tree,
          treeRoot: treeRootOf(creds),
        },
      };
    } catch (error) {
      // Best-effort like the hook: ANY per-project resolution failure —
      // malformed/untrusted `.me`, the `.me` agent sentinel with no project
      // agent, … — skips this project's sessions instead of killing the
      // sweep. The message lands in the skip detail (verbose output); a
      // local import inside the project reproduces the error loudly.
      return {
        skip: "project_config_error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return (cwd) => {
    if (!cwd) return base;
    let decision = routeByCwd.get(cwd);
    if (!decision) {
      decision = computeRoute(cwd);
      routeByCwd.set(cwd, decision);
    }
    return decision;
  };
}

/**
 * Run one importer end-to-end and render the outcome in the selected format.
 *
 * Exported so higher-level commands (e.g. `me claude init`) can run an import
 * as one step among several, reusing the exact same auth/option/render path as
 * the standalone `import` subcommand. `opts` is the parsed import-flag set (pass
 * `{}` for defaults); `globalOpts` carries `--server` / output format.
 */
export async function runAgentImport(
  importer: Importer,
  opts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const fmt = getOutputFormat(globalOpts);
  // A config-dir pin means "use exactly this .me" — a single-project concept
  // that contradicts per-session routing (every session resolves its OWN
  // project's config). Reject the combination loudly rather than silently
  // ignoring the pin for routing; single-target commands (`me import git`,
  // the capture hooks, `me mcp`) keep honoring it.
  if (typeof globalOpts.configDir === "string" || process.env.ME_CONFIG_DIR) {
    handleError(
      new Error(
        "--config-dir / ME_CONFIG_DIR does not apply to session imports: " +
          "every session routes by its own project's .me. Scope the sweep " +
          "with --project <path>, or force a target with ME_SERVER / " +
          "ME_SPACE / --tree-root.",
      ),
      fmt,
    );
  }
  const creds = resolveCredentials(
    typeof globalOpts.server === "string" ? globalOpts.server : undefined,
  );
  requireAuth(creds, fmt);
  requireSpace(creds, fmt);

  let config: ReturnType<typeof buildOptions>;
  try {
    config = buildOptions(opts, creds);
  } catch (error) {
    handleError(error, fmt);
  }

  const engine = buildMemoryClient(creds);
  // Bulk imports route each session by ITS project's config — full
  // per-project server/space/tree, mirroring the live hook.
  const router = createSessionRouter({
    explicitTreeRoot:
      typeof opts.treeRoot === "string" ? opts.treeRoot : undefined,
    base: { creds, engine },
  });

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
      router,
    );
  } catch (error) {
    progress?.stop();
    handleError(error, fmt, { creds, scope: "space" });
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
    console.log(`  Scanned ${result.discovery.totalFiles} session sources`);
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
 * Build a subcommand bound to a specific importer. Each importer is
 * registered twice: under the `me import` group as `me import <tool>` (its
 * canonical spelling) and under the agent's command group as the
 * `me <tool> import` alias — hence the `name` parameter.
 */
function buildAgentImportSubcommand(
  description: string,
  importer: Importer,
  includeSidechainsFlag = false,
  name = "import",
): Command {
  const cmd = new Command(name).description(description);
  addCommonOptions(cmd, includeSidechainsFlag);
  cmd.action(async (opts, cmdRef) => {
    const globalOpts = cmdRef.optsWithGlobals();
    await runAgentImport(importer, opts, globalOpts);
  });
  return cmd;
}

/**
 * Per-tool import subcommand factories. Each owns its importer wiring +
 * description in one place so both registrations (`me import <tool>` and the
 * `me <tool> import` alias) stay identical.
 */
export function createClaudeImportCommand(name = "import"): Command {
  return buildAgentImportSubcommand(
    "import Claude Code sessions from ~/.claude/projects",
    claudeImporter,
    true,
    name,
  );
}

export function createCodexImportCommand(name = "import"): Command {
  return buildAgentImportSubcommand(
    "import Codex sessions from ~/.codex/sessions and archived_sessions",
    codexImporter,
    false,
    name,
  );
}

export function createOpenCodeImportCommand(name = "import"): Command {
  return buildAgentImportSubcommand(
    "import OpenCode sessions from ~/.local/share/opencode/opencode.db or legacy storage",
    opencodeImporter,
    false,
    name,
  );
}
