/**
 * me claude — Claude Code integration commands.
 *
 * `me claude install` has two modes:
 *
 *   1. Full plugin (default) — installs the Memory Engine plugin (hooks +
 *      slash commands + MCP) via Claude Code's native plugin marketplace,
 *      driving the same commands you'd otherwise run by hand:
 *
 *        claude plugin marketplace add timescale/memory-engine
 *        claude plugin install memory-engine@memory-engine \
 *          --config server=… [--config space=…] [--config api_key=…]
 *
 *      Claude Code delivers the configured values to our hook (`me claude
 *      hook --event <name>`) via CLAUDE_PLUGIN_OPTION_* env vars. api_key is
 *      optional: left blank, the hook (and the plugin's MCP server) use your
 *      `me login` session.
 *
 *      Pass --dev (run from inside the repo) to install the plugin from your
 *      local checkout — the repo's .claude-plugin/marketplace.json — instead of
 *      the published marketplace. The two share the marketplace name
 *      "memory-engine", so --dev re-points it at your working tree and
 *      reinstalls fresh (plugin files are copied into the cache, so a new build
 *      needs a reinstall).
 *
 *   2. MCP-only (`--mcp-only`) — registers `me` as an MCP server with Claude
 *      Code (no hooks, no slash commands — just the tools).
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { Command, InvalidArgumentError } from "commander";
import {
  HOOK_EVENT_NAMES,
  type HookEvent,
  type HookEventName,
  resolveHookConfigFromEnv,
  SESSIONS_NODE,
} from "../claude/capture.ts";
import { createMemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { claudeImporter } from "../importers/claude.ts";
import { GIT_HISTORY_NODE_NAME } from "../importers/git.ts";
import {
  DEFAULT_SESSIONS_NODE_NAME,
  DEFAULT_TREE_ROOT,
  importTranscriptFile,
} from "../importers/index.ts";
import { SlugRegistry } from "../importers/slug.ts";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";
import { getOutputFormat } from "../output.ts";
import { createClaudeImportCommand, runAgentImport } from "./import.ts";
import { runGitImport } from "./import-git.ts";

/** GitHub source for `claude plugin marketplace add`. */
const PLUGIN_MARKETPLACE_SOURCE = "timescale/memory-engine";
/** The marketplace `name` (from .claude-plugin/marketplace.json). */
const PLUGIN_MARKETPLACE_NAME = "memory-engine";
/** `<plugin>@<marketplace>` ref for `claude plugin install`. */
const PLUGIN_REF = `memory-engine@${PLUGIN_MARKETPLACE_NAME}`;

const CLAUDE_SCOPES = ["local", "user", "project"] as const;
type ClaudeScope = (typeof CLAUDE_SCOPES)[number];

function parseClaudeScope(value: string): ClaudeScope {
  if (!CLAUDE_SCOPES.includes(value as ClaudeScope)) {
    throw new InvalidArgumentError(
      `must be one of: ${CLAUDE_SCOPES.join(", ")}`,
    );
  }
  return value as ClaudeScope;
}

/**
 * me claude install — install the Memory Engine plugin for Claude Code.
 *
 * Default: the full plugin (hooks + slash commands + MCP), installed via
 * Claude Code's native plugin marketplace. `--mcp-only` falls back to
 * registering just the `me` MCP server (no hooks, no slash commands).
 */
function createClaudeInstallCommand(): Command {
  return new Command("install")
    .description(
      "install the Memory Engine plugin for Claude Code (hooks + slash commands + MCP)",
    )
    .option(
      "--mcp-only",
      "register only the me MCP server (no hooks or slash commands)",
    )
    .option(
      "--api-key <key>",
      "API key for a headless agent (default: use your login session at runtime)",
    )
    .option("--server <url>", "server URL to embed in the config")
    .option(
      "--space <slug>",
      "pin a space (default: resolve ME_SPACE / active space at runtime)",
    )
    .option(
      "-s, --scope <scope>",
      `Claude Code config scope (${CLAUDE_SCOPES.join(", ")})`,
      parseClaudeScope,
      "user",
    )
    .option(
      "--dev",
      "install the plugin from the local checkout instead of the published marketplace (run from inside the repo)",
    )
    .action(
      async (
        opts: AgentInstallOptions & {
          scope: ClaudeScope;
          mcpOnly?: boolean;
          dev?: boolean;
        },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        const server = globalOpts.server ?? opts.server;
        if (opts.mcpOnly) {
          if (opts.dev) {
            clack.log.warn(
              "--dev has no effect with --mcp-only: the MCP server already runs your local `me` binary on PATH.",
            );
          }
          await runAgentMcpInstall("claude", {
            apiKey: opts.apiKey,
            server,
            space: opts.space,
            scope: opts.scope,
          });
          return;
        }
        await runClaudePluginInstall({
          apiKey: opts.apiKey,
          server,
          space: opts.space,
          scope: opts.scope,
          dev: opts.dev,
        });
      },
    );
}

/** Run a command, capturing its exit code, stdout, and stderr. */
async function runCommand(
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

/**
 * Walk up from `startDir` to the repo's marketplace manifest
 * (`.claude-plugin/marketplace.json`), returning the directory that contains it
 * — the marketplace root passed to `claude plugin marketplace add`. Used by
 * `--dev` to install the plugin from the local checkout. Returns undefined when
 * not run from inside the repo.
 */
function findRepoMarketplaceRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".claude-plugin", "marketplace.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

/**
 * Install the full Memory Engine plugin for Claude Code.
 *
 * Drives Claude Code's plugin CLI: registers the marketplace (idempotent — a
 * no-op if it's already configured) and installs the plugin, passing the
 * resolved server/space/api_key through `--config` (the same path as the
 * interactive `/plugin` configure flow). Credential handling mirrors the
 * MCP-only path: an api key requires a pinned space; otherwise the plugin
 * falls back to your `me login` session at runtime.
 */
async function runClaudePluginInstall(
  opts: AgentInstallOptions & { scope: ClaudeScope; dev?: boolean },
): Promise<void> {
  if (Bun.which("claude") === null) {
    clack.log.error(
      "Claude Code (claude) not found on PATH. Install it first.",
    );
    process.exit(1);
  }

  // Resolve credentials: flags > env (ME_API_KEY / ME_SERVER / ME_SPACE) >
  // stored config.
  const creds = resolveCredentials(opts.server);
  const apiKey = opts.apiKey ?? creds.apiKey;
  const server = opts.server ?? creds.server;
  if (!server) {
    clack.log.error("No server URL available. Pass --server or set ME_SERVER.");
    process.exit(1);
  }
  const space = opts.space ?? creds.activeSpace;

  if (apiKey) {
    // A global key isn't space-bound, so the space must be fixed.
    if (!space) {
      clack.log.error(
        "No space for the API key. Pass --space, set ME_SPACE, or run 'me space use <space>' (keys are global, so the space must be fixed).",
      );
      process.exit(1);
    }
  } else if (!creds.sessionToken) {
    clack.log.error(
      "Not logged in. Run 'me login' (the plugin will use your session), or pass --api-key / set ME_API_KEY for a headless agent.",
    );
    process.exit(1);
  } else if (!space) {
    clack.log.warn(
      "No active space set — captures are skipped until you run 'me space use <space>' (or set ME_SPACE). Re-run with --space to pin one.",
    );
  }

  // Resolve the marketplace source: the published GitHub repo, or — with --dev
  // — the local checkout, so captures exercise the plugin files from your
  // working tree (.mcp.json, hooks, slash commands) rather than the published
  // version.
  let marketplaceSource = PLUGIN_MARKETPLACE_SOURCE;
  if (opts.dev) {
    const root = findRepoMarketplaceRoot(process.cwd());
    if (!root) {
      clack.log.error(
        "--dev must be run from inside the memory-engine repo (no .claude-plugin/marketplace.json found at or above the current directory).",
      );
      process.exit(1);
    }
    marketplaceSource = root;
  }

  const spin = clack.spinner();

  // 1. Register the marketplace.
  if (opts.dev) {
    // The local and published marketplaces share the name "memory-engine", so
    // they can't coexist and `marketplace add` won't re-point an existing name;
    // plugin install also copies files into the cache, so a fresh build needs a
    // reinstall. Tear both down first (ignoring "not found" — these may be a
    // no-op on a clean machine), then re-add from the local checkout so the
    // install below picks up your working tree.
    spin.start(
      "Pointing the Memory Engine marketplace at your local checkout...",
    );
    await runCommand([
      "claude",
      "plugin",
      "uninstall",
      "-y",
      "-s",
      opts.scope,
      PLUGIN_REF,
    ]);
    await runCommand([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      PLUGIN_MARKETPLACE_NAME,
    ]);
    const add = await runCommand([
      "claude",
      "plugin",
      "marketplace",
      "add",
      "--scope",
      opts.scope,
      marketplaceSource,
    ]);
    if (add.exitCode !== 0 && !/already/i.test(add.stderr + add.stdout)) {
      spin.stop("Failed to add the local marketplace");
      clack.log.error(
        `claude plugin marketplace add exited with ${add.exitCode}${add.stderr ? ` — ${add.stderr.trim()}` : ""}`,
      );
      process.exit(1);
    }
  } else {
    // Idempotent: skip if already there.
    spin.start("Adding the Memory Engine marketplace...");
    const list = await runCommand(["claude", "plugin", "marketplace", "list"]);
    const alreadyAdded =
      list.exitCode === 0 && list.stdout.includes(marketplaceSource);
    if (!alreadyAdded) {
      const add = await runCommand([
        "claude",
        "plugin",
        "marketplace",
        "add",
        "--scope",
        opts.scope,
        marketplaceSource,
      ]);
      if (add.exitCode !== 0 && !/already/i.test(add.stderr + add.stdout)) {
        spin.stop("Failed to add the marketplace");
        clack.log.error(
          `claude plugin marketplace add exited with ${add.exitCode}${add.stderr ? ` — ${add.stderr.trim()}` : ""}`,
        );
        process.exit(1);
      }
    }
  }

  // 2. Install the plugin, baking the resolved config so captures land in the
  //    right space. Leave tree_root / content_mode at the plugin defaults
  //    (reconfigure them later via `/plugin` if needed).
  spin.message("Installing the memory-engine plugin...");
  const install = ["claude", "plugin", "install", "--scope", opts.scope];
  install.push("--config", `server=${server}`);
  if (space) install.push("--config", `space=${space}`);
  if (apiKey) install.push("--config", `api_key=${apiKey}`);
  install.push(PLUGIN_REF);

  const result = await runCommand(install);
  if (result.exitCode !== 0) {
    if (/already/i.test(result.stderr + result.stdout)) {
      spin.stop("Memory Engine plugin already installed");
      clack.log.info(
        "Run '/plugin' in Claude Code to reconfigure (or '--mcp-only' for the MCP server alone).",
      );
      return;
    }
    spin.stop("Failed to install the plugin");
    clack.log.error(
      `claude plugin install exited with ${result.exitCode}${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
    );
    process.exit(1);
  }

  spin.stop(
    opts.dev
      ? "Installed the Memory Engine plugin from your local checkout"
      : "Installed the Memory Engine plugin for Claude Code",
  );
  clack.log.info(
    "Restart Claude Code (or run '/plugin') to load the hooks + slash commands.",
  );
}

/**
 * me claude hook — invoked by the Claude Code plugin on Stop / SessionEnd to
 * capture the session.
 *
 * Reads the event JSON from stdin for the `transcript_path`, resolves config
 * from the CLAUDE_PLUGIN_OPTION_* env vars (falling back to the `me login`
 * session when no api_key is configured), and runs the transcript through
 * `importTranscriptFile` — the same parse + write as `me import claude`, incremental so
 * each call only writes messages new since the last.
 *
 * Best-effort: logs failures to stderr but always exits 0 so that a hook
 * failure never blocks a Claude Code session.
 */
function createClaudeHookCommand(): Command {
  return new Command("hook")
    .description("invoked by Claude Code plugin hooks (reads event from stdin)")
    .requiredOption(
      "--event <name>",
      `hook event name (${HOOK_EVENT_NAMES.join(", ")})`,
    )
    .action(async (opts: { event: string }) => {
      const eventName = opts.event as HookEventName;
      if (!HOOK_EVENT_NAMES.includes(eventName)) {
        console.error(
          `[memory-engine] unknown event '${opts.event}'. Expected one of: ${HOOK_EVENT_NAMES.join(", ")}`,
        );
        process.exit(0);
      }

      // Resolve config: the plugin's api_key if configured, else fall back to
      // the user's `me login` session (resolved from the keychain/config).
      const config = resolveHookConfigFromEnv(
        process.env,
        resolveCredentials(),
      );
      if (!config) {
        console.error(
          "[memory-engine] no credentials. Run `me login`, or set the plugin's " +
            "api_key + space via `/plugin` in Claude Code.",
        );
        process.exit(0);
      }

      // Read + parse the event JSON from stdin for the transcript path.
      let event: HookEvent;
      try {
        event = JSON.parse(await Bun.stdin.text()) as HookEvent;
      } catch (error) {
        console.error(
          `[memory-engine] failed to read/parse event JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(0);
      }

      const transcriptPath = event.transcript_path;
      if (!transcriptPath) {
        console.error(
          `[memory-engine] ${eventName}: no transcript_path in event payload`,
        );
        process.exit(0);
      }

      // Import the transcript (incremental; same path as `me import claude`).
      try {
        const client = createMemoryClient({
          url: config.server,
          token: config.token,
          space: config.space,
        });
        await importTranscriptFile(client, claudeImporter, transcriptPath, {
          treeRoot: config.treeRoot,
          sessionsNodeName: SESSIONS_NODE,
          fullTranscript: config.fullTranscript,
          dryRun: false,
          verbose: false,
        });
      } catch (error) {
        console.error(
          `[memory-engine] ${eventName} capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      process.exit(0);
    });
}

/** Markers delimiting the section `me claude init` manages in a CLAUDE.md. */
const CLAUDE_MD_START =
  "<!-- memory-engine:start (managed by `me claude init`) -->";
const CLAUDE_MD_END = "<!-- memory-engine:end -->";

/** Dim (secondary text) ANSI, for de-emphasizing hint copy. `\x1b[22m` resets
 * only the dim attribute so surrounding clack styling is left intact. */
const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

/**
 * Build the managed CLAUDE.md block that tells an agent where this project's
 * memories live in Memory Engine and how to search them. `projectTree` is the
 * canonical (dot-separated) ltree path (e.g. `share.projects.foo`); `space` is
 * the active space slug, if known.
 */
function buildClaudeMdSection(projectTree: string, space?: string): string {
  const sessions = `${projectTree}.${DEFAULT_SESSIONS_NODE_NAME}`;
  const gitHistory = `${projectTree}.${GIT_HISTORY_NODE_NAME}`;
  const where = space ? `Memory Engine (space \`${space}\`)` : "Memory Engine";
  return [
    CLAUDE_MD_START,
    "## Project memories (Memory Engine)",
    "",
    `Prior context for this project — including captured/imported Claude Code`,
    `sessions — is stored in ${where} under the tree:`,
    "",
    `    ${projectTree}`,
    "",
    `- Captured & imported agent sessions: \`${sessions}\``,
    `- Imported git commit history: \`${gitHistory}\``,
    `- Search them with the \`me_memory_search\` MCP tool (set \`tree\` to`,
    `  \`${projectTree}\`), or from a shell: \`me search "<query>" --tree ${projectTree}\`.`,
    "",
    "Always consult these memories when exploring the codebase or starting a",
    "task: search them FIRST to recall earlier decisions and context before",
    "digging into the code.",
    CLAUDE_MD_END,
    "",
  ].join("\n");
}

/**
 * Upsert the managed Memory Engine section into the project's CLAUDE.md.
 *
 * Idempotent: if the marker block already exists it is replaced in place;
 * otherwise the block is appended (creating the file if absent). Writes to the
 * git repo root's CLAUDE.md when in a repo, else the current directory's.
 */
async function writeProjectMemoryPointer(server?: string): Promise<void> {
  const cwd = process.cwd();
  const { slug, gitRoot } = await new SlugRegistry().resolve(cwd);
  const projectTree = `${DEFAULT_TREE_ROOT}.${slug}`;
  const space = resolveCredentials(server).activeSpace;
  const section = buildClaudeMdSection(projectTree, space);

  const claudeMdPath = join(gitRoot ?? cwd, "CLAUDE.md");
  let existing = "";
  try {
    existing = await readFile(claudeMdPath, "utf8");
  } catch {
    existing = ""; // no file yet → create it
  }

  let next: string;
  const start = existing.indexOf(CLAUDE_MD_START);
  if (start !== -1) {
    // Replace the existing managed block in place.
    const endMarker = existing.indexOf(CLAUDE_MD_END, start);
    const end =
      endMarker === -1 ? existing.length : endMarker + CLAUDE_MD_END.length;
    // Swallow a single trailing newline after the old block so we don't grow
    // blank lines on every re-run.
    const tail = existing[end] === "\n" ? end + 1 : end;
    next = existing.slice(0, start) + section + existing.slice(tail);
  } else if (existing.trim().length === 0) {
    next = section;
  } else {
    // Append after the existing content with one blank line of separation.
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    next = existing + sep + section;
  }

  await writeFile(claudeMdPath, next);
  clack.log.success(`Recorded project memory location in ${claudeMdPath}`);
}

/**
 * me claude init — one-shot setup of Claude Code memory integration.
 *
 * Setup is a list of independent steps (see INIT_STEPS). In an interactive
 * terminal `init` presents a multiselect of all steps (each pre-checked) so the
 * user can deselect any; non-interactively it runs every step except those
 * turned off by a `--skip-<step>` flag. To add a step, append one entry to
 * INIT_STEPS — it picks up both a `--skip-*` flag and a multiselect row
 * automatically.
 */
interface InitStepContext {
  /** Global CLI opts (carries --server, output format) for the step to use. */
  globalOpts: Record<string, unknown>;
  /** Resolved server URL, if any. */
  server?: string;
}

interface InitStep {
  /** Stable id — the multiselect value and the basis of the --skip flag. */
  id: string;
  /** Commander-parsed key for this step's skip flag (e.g. skipClaudeMd). */
  optionKey: string;
  /** The skip flag (e.g. "--skip-claude-md"). */
  skipFlag: string;
  /** Help text for the skip flag. */
  skipDescription: string;
  /** Multiselect row label. */
  label: string;
  /** Perform the step. */
  run: (ctx: InitStepContext) => Promise<void>;
}

const INIT_STEPS: InitStep[] = [
  {
    id: "transcript-import",
    optionKey: "skipTranscriptImport",
    skipFlag: "--skip-transcript-import",
    skipDescription: "do not import existing Claude Code sessions",
    label: "Import existing Claude Code sessions",
    run: ({ globalOpts }) => runAgentImport(claudeImporter, {}, globalOpts),
  },
  {
    id: "git-import",
    optionKey: "skipGitImport",
    skipFlag: "--skip-git-import",
    skipDescription: "do not import the repo's git commit history",
    label: "Import git commit history",
    run: ({ globalOpts }) => runGitImport({ skipIfNotRepo: true }, globalOpts),
  },
  {
    id: "claude-md",
    optionKey: "skipClaudeMd",
    skipFlag: "--skip-claude-md",
    skipDescription:
      "do not write the memory pointer into the project's CLAUDE.md",
    label: "Add a memory pointer to CLAUDE.md",
    run: ({ server }) => writeProjectMemoryPointer(server),
  },
];

function createClaudeInitCommand(): Command {
  const cmd = new Command("init").description(
    "set up Claude Code memory integration (interactive step picker; otherwise runs all steps)",
  );
  // One --skip-<step> flag per step, so non-interactive runs can opt out.
  for (const step of INIT_STEPS) {
    cmd.option(step.skipFlag, step.skipDescription);
  }
  cmd.action(async (opts: Record<string, unknown>, cmdRef: Command) => {
    const globalOpts = cmdRef.optsWithGlobals();
    const server =
      typeof globalOpts.server === "string" ? globalOpts.server : undefined;

    // Baseline = every step not explicitly turned off via its --skip-* flag.
    const baseline = INIT_STEPS.filter((s) => opts[s.optionKey] !== true);

    // Interactive (a TTY with text output): present a multiselect pre-checked
    // with the baseline so the user can deselect steps. Otherwise run the
    // baseline as-is.
    const interactive =
      getOutputFormat(globalOpts) === "text" &&
      Boolean(process.stdin.isTTY) &&
      Boolean(process.stdout.isTTY);

    let selectedIds: string[];
    if (interactive) {
      const picked = await clack.multiselect<string>({
        message: `Setup steps to run ${DIM}(all selected by default — ↑/↓ move, space to toggle off/on, enter to confirm)${DIM_OFF}`,
        options: INIT_STEPS.map((s) => ({
          value: s.id,
          label: s.label,
        })),
        initialValues: baseline.map((s) => s.id),
        required: false,
      });
      if (clack.isCancel(picked)) {
        clack.cancel("Cancelled.");
        process.exit(0);
      }
      selectedIds = picked;
    } else {
      selectedIds = baseline.map((s) => s.id);
    }

    const selected = INIT_STEPS.filter((s) => selectedIds.includes(s.id));
    if (selected.length === 0) {
      clack.log.info("No setup steps selected — nothing to do.");
      return;
    }

    const ctx: InitStepContext = { globalOpts, server };
    for (const step of selected) {
      await step.run(ctx);
    }
  });
  return cmd;
}

export function createClaudeCommand(): Command {
  const claude = new Command("claude").description("Claude Code integration");
  claude.addCommand(createClaudeInstallCommand());
  claude.addCommand(createClaudeInitCommand());
  claude.addCommand(createClaudeHookCommand());
  claude.addCommand(createClaudeImportCommand());
  return claude;
}
