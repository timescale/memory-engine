/**
 * me claude — Claude Code integration commands.
 *
 * `me claude install` has two modes:
 *
 *   1. Full plugin (default) — installs the ONE user-scoped Memory Engine
 *      plugin (hooks + slash commands + MCP) via Claude Code's native plugin
 *      marketplace, driving the same commands you'd otherwise run by hand:
 *
 *        claude plugin marketplace add timescale/memory-engine
 *        claude plugin install memory-engine@memory-engine \
 *          [--config server=…] [--config space=…] [--config api_key=…]
 *
 *      Claude Code delivers any configured values to our hook (`me claude
 *      hook --event <name>`) and the plugin's MCP server via CLAUDE_PLUGIN_OPTION_*
 *      env vars. By default we pin NOTHING — a personal install leaves all three
 *      blank so the plugin tracks your live `me` config at runtime (default
 *      server, active space, login session), the same fallback the CLI uses.
 *      Pinning is opt-in: `--server` / `--space` pin those, and an api key
 *      (`--api-key` / ME_API_KEY) marks a headless install — no session to fall
 *      back to — so it bakes in a fixed server + space + key together.
 *
 *      A session (non-headless) install then persists global defaults into
 *      `~/.config/me` — the resolved server + active space — and ASKS whether
 *      to turn on session capture (default no; the hook ships inert). Opting
 *      in writes the machine-wide `capture: true` and runs a one-time
 *      machine-wide `me import claude` backfill; per-project `.me/config.yaml`
 *      `capture` still overrides either way.
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
import { dirname, join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { ensureDefaultAgent } from "../agent/default-agent.ts";
import type { StepAvailability } from "../agent/init.ts";
import {
  HOOK_EVENT_NAMES,
  type HookEvent,
  type HookEventName,
  resolveCaptureEnabled,
  resolveHookConfigFromEnv,
  SESSIONS_NODE,
} from "../claude/capture.ts";
import { createMemoryClient } from "../client.ts";
import {
  resolveCredentials,
  resolveHarnessAgent,
  setActiveSpace,
  setCaptureEnabled,
  setDefaultServer,
} from "../credentials.ts";
import {
  buildContractVars,
  isInjectionLive,
  upsertContractBlock,
} from "../harness-contract.ts";
import { claudeImporter } from "../importers/claude.ts";
import { importTranscriptFile } from "../importers/index.ts";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";
import {
  discoverProjectConfig,
  setConfigDirOverride,
} from "../project-config.ts";
import { memoryBearer } from "../session.ts";
import { runCapturePrompt } from "./capture-prompt.ts";
import { createClaudeImportCommand, runAgentImport } from "./import.ts";

/** GitHub source for `claude plugin marketplace add`. */
const PLUGIN_MARKETPLACE_SOURCE = "timescale/memory-engine";
/** The marketplace `name` (from .claude-plugin/marketplace.json). */
const PLUGIN_MARKETPLACE_NAME = "memory-engine";
/** `<plugin>@<marketplace>` ref for `claude plugin install`. */
const PLUGIN_REF = `memory-engine@${PLUGIN_MARKETPLACE_NAME}`;

/**
 * The one plugin install is user-scoped — there is no `--scope` choice.
 * Per-project behavior comes from committed config (`.me/config.yaml`), not
 * from a second project-scope plugin.
 */
const PLUGIN_SCOPE = "user";

/**
 * me claude install — install the Memory Engine plugin for Claude Code.
 *
 * Default: the full plugin (hooks + slash commands + MCP), installed once at
 * user scope via Claude Code's native plugin marketplace, then persist global
 * defaults + the capture opt-in (see {@link runClaudeInstallFlow}).
 * `--mcp-only` falls back to registering just the `me` MCP server (no hooks,
 * no slash commands).
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
      "--dev",
      "install the plugin from the local checkout instead of the published marketplace (run from inside the repo)",
    )
    .option(
      "--no-default-agent",
      "skip provisioning a default agent (agent: coder) for this install",
    )
    .action(
      async (
        opts: AgentInstallOptions & {
          mcpOnly?: boolean;
          dev?: boolean;
          defaultAgent?: boolean;
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
            scope: PLUGIN_SCOPE,
          });
          return;
        }
        await runClaudeInstallFlow(
          {
            apiKey: opts.apiKey,
            server,
            space: opts.space,
            dev: opts.dev,
            defaultAgent: opts.defaultAgent,
          },
          globalOpts,
        );
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

/** The `--config` args to bake into the install, or a fatal validation error. */
export type PluginConfigDecision =
  | { config: string[]; warn?: string }
  | { error: string };

/**
 * Decide what (if anything) to pin into the plugin config. Pure, so it's unit
 * tested independently of the install shell-out.
 *
 * Default: pin NOTHING for a personal (session) install, so the plugin tracks
 * your live `me` config at runtime — default server, active space, and login
 * session — the same fallback the CLI itself uses (see `me mcp`). Pinning is
 * opt-in: explicit `server` / `space` pin those; an api key (`--api-key` /
 * `ME_API_KEY`, surfaced as `creds.apiKey`) marks a headless install with no
 * session to fall back to, so it bakes in a fixed server + space + key together.
 */
export function buildPluginConfig(
  opts: { server?: string; space?: string; apiKey?: string },
  creds: {
    server: string;
    activeSpace?: string;
    apiKey?: string;
    loggedIn: boolean;
  },
): PluginConfigDecision {
  const apiKey = opts.apiKey ?? creds.apiKey;
  if (apiKey) {
    const server = opts.server ?? creds.server;
    const space = opts.space ?? creds.activeSpace;
    if (!server) {
      return {
        error: "No server URL available. Pass --server or set ME_SERVER.",
      };
    }
    if (!space) {
      return {
        error:
          "No space for the API key. Pass --space, set ME_SPACE, or run 'me space use <space>' (keys are global, so the space must be fixed).",
      };
    }
    return {
      config: [
        "--config",
        `server=${server}`,
        "--config",
        `space=${space}`,
        "--config",
        `api_key=${apiKey}`,
      ],
    };
  }
  if (!creds.loggedIn) {
    return {
      error:
        "Not logged in. Run 'me login' (the plugin will use your session), or pass --api-key / set ME_API_KEY for a headless agent.",
    };
  }
  const config: string[] = [];
  if (opts.server) config.push("--config", `server=${opts.server}`);
  if (opts.space) config.push("--config", `space=${opts.space}`);
  const warn =
    !opts.space && !creds.activeSpace
      ? "No active space set — captures are skipped until you run 'me space use <space>' (or set ME_SPACE / re-run with --space to pin one)."
      : undefined;
  return { config, warn };
}

/**
 * Install the full Memory Engine plugin for Claude Code (user scope, the one
 * plugin — see {@link PLUGIN_SCOPE}).
 *
 * Drives Claude Code's plugin CLI: registers the marketplace (idempotent — a
 * no-op if it's already configured) and installs the plugin, baking in only the
 * config {@link buildPluginConfig} chose to pin (none by default). Credential
 * handling mirrors the MCP-only path: an api key needs a resolvable space
 * (`--space`, `ME_SPACE`, or your active space — it gets baked in), since a
 * global key has no active space to fall back to at runtime; otherwise the
 * plugin uses your `me login` session.
 *
 * Install only — persisting global defaults and the capture prompt live in
 * {@link runClaudeInstallFlow} (so callers like the init step can install
 * without prompting).
 */
export async function runClaudePluginInstall(
  opts: AgentInstallOptions & { dev?: boolean },
): Promise<void> {
  if (Bun.which("claude") === null) {
    clack.log.error(
      "Claude Code (claude) not found on PATH. Install it first.",
    );
    process.exit(1);
  }

  // Decide what (if anything) to pin into the plugin config — see
  // {@link buildPluginConfig}. Default pins NOTHING so the plugin tracks your
  // live `me` config at runtime.
  const creds = resolveCredentials(opts.server);
  const decision = buildPluginConfig(opts, creds);
  if ("error" in decision) {
    clack.log.error(decision.error);
    process.exit(1);
  }
  if (decision.warn) clack.log.warn(decision.warn);
  const config = decision.config;

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
      PLUGIN_SCOPE,
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
      PLUGIN_SCOPE,
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
        PLUGIN_SCOPE,
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

  // 2. Install the plugin, baking in only the config we chose to pin above
  //    (none by default — the plugin then tracks your live `me` config). Leave
  //    content_mode at the plugin default (reconfigure later via
  //    `/plugin` if needed).
  spin.message("Installing the memory-engine plugin...");
  const install = [
    "claude",
    "plugin",
    "install",
    "--scope",
    PLUGIN_SCOPE,
    ...config,
    PLUGIN_REF,
  ];

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
 * The full `me claude install` flow: install the plugin, then — for a session
 * (non-headless) install — persist global defaults and ask about capture.
 *
 *   1. {@link runClaudePluginInstall} (a re-run of an already-installed plugin
 *      is fine — the flow continues, so re-running `me claude install` is how
 *      you change the capture setting later).
 *   2. Persist the resolved server + active space into `~/.config/me`
 *      (`setDefaultServer` / `setActiveSpace`) so the plugin's runtime
 *      fallbacks are deterministic. The private `~/projects` tree root and
 *      "no agent" are code defaults — nothing else is written.
 *   3. {@link ensureDefaultAgent} — provisions-or-adopts the machine-wide
 *      default agent (`coder`) so harness surfaces have an agent in scope by
 *      default (skippable with `--no-default-agent`).
 *   4. The shared capture opt-in ({@link runCapturePrompt}): ask (interactive
 *      TTY only; default = the current setting, initially off), persist the
 *      machine-wide flag, and on yes run a one-time machine-wide `me import
 *      claude` backfill (each project's sessions land under the same private
 *      `~/projects/<slug>` node live capture uses).
 *
 * A headless install (api key) skips 2–4: the config is baked into the plugin
 * for whatever machine it runs on, and this machine's `~/.config/me` — the
 * operator's — is not necessarily the agent's (and the api key already IS an
 * agent — see {@link ensureDefaultAgent}). Capture is credential-agnostic
 * (`resolveCaptureEnabled`), so a headless deployment opts in via the same
 * flags as everyone else: a committed `.me` `capture: true` per project, or
 * `capture: true` in the target machine's `~/.config/me/config.yaml`.
 */
export async function runClaudeInstallFlow(
  opts: AgentInstallOptions & {
    dev?: boolean;
    defaultAgent?: boolean;
    /** Set when called from `me project init`'s preflight — see
     * {@link ensureDefaultAgent}'s matching option. */
    perProjectStepFollows?: boolean;
  },
  globalOpts: Record<string, unknown>,
): Promise<void> {
  await runClaudePluginInstall(opts);

  const creds = resolveCredentials(opts.server);
  const headless = Boolean(opts.apiKey ?? creds.apiKey);
  if (headless) return;

  // Persist global defaults: the server + space this install resolved.
  setDefaultServer(creds.server);
  const space = opts.space ?? creds.activeSpace;
  if (space) setActiveSpace(creds.server, space);

  if (opts.defaultAgent !== false) {
    await ensureDefaultAgent(
      { ...creds, activeSpace: space },
      { perProjectStepFollows: opts.perProjectStepFollows },
    );
  }

  // Capture opt-in (shared with `me opencode install`): prompt, persist the
  // machine-wide flag, and backfill existing sessions on yes.
  await runCapturePrompt(claudeImporter, globalOpts, {
    space,
    toolLabel: "Claude Code",
    installCmd: "me claude install",
  });
}

/**
 * me claude env — invoked by the Claude Code plugin's SessionStart hook to
 * inject the harness contract into `$CLAUDE_ENV_FILE`, which Claude Code
 * sources before every Bash tool command — so a plain `me`
 * call from the agent's shell always resolves the right project
 * (`ME_PROJECT_DIR`, the discovery anchor) and always runs as the configured
 * agent (`ME_AS_AGENT=.me`, the ordinary sentinel).
 *
 * First-writer-wins: if a live `ME_INJECT_V` is already in THIS process's own
 * inherited env, this Claude session was itself spawned inside another
 * session's contract (a nested harness) — emit nothing rather than
 * clobbering it. Idempotent otherwise: SessionStart refires on resume and
 * `/clear`, and {@link upsertContractBlock} replaces its own block in place.
 *
 * Fails open on anything unexpected — a missing `$CLAUDE_ENV_FILE`, an
 * unparseable/cwd-less event payload, or a write error (permission denied,
 * disk full) — since a broken injection must degrade to "no contract"
 * (caught by the failsafe), never break the session. Always exits 0; a
 * write error is logged to stderr but never propagates as a process failure.
 */
function createClaudeEnvCommand(): Command {
  return new Command("env")
    .description(
      "invoked by Claude Code's SessionStart hook to inject the harness contract into $CLAUDE_ENV_FILE",
    )
    .action(async () => {
      if (isInjectionLive()) process.exit(0);

      let event: HookEvent = {};
      try {
        event = JSON.parse(await Bun.stdin.text()) as HookEvent;
      } catch {
        // Malformed/empty payload — nothing to anchor on.
      }

      const envFile = process.env.CLAUDE_ENV_FILE;
      if (!envFile || !event.cwd) process.exit(0);

      try {
        upsertContractBlock(envFile, buildContractVars("claude", event.cwd));
      } catch (error) {
        console.error(
          `[memory-engine] failed to write the harness contract to ${envFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exit(0);
    });
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
 * Inert unless capture is enabled (see `resolveCaptureEnabled`): with capture
 * off — the default — the hook exits 0 silently, a deliberate opt-out distinct
 * from the "no credentials" error path.
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

      // Read + parse the event JSON from stdin (transcript path + cwd).
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

      // Resolve config: the plugin's api_key if configured, else the user's
      // `me login` session (from the keychain/config). Server/space/tree fall
      // back to the session project's `.me/config.yaml` (from the event cwd),
      // so a per-project tree routes live captures without a plugin reinstall.
      // A broken `.me` is fatal for direct CLI use, but the hook is best-effort:
      // log + exit 0 so a typo never blocks the session.
      let config: ReturnType<typeof resolveHookConfigFromEnv>;
      try {
        const project = event.cwd
          ? discoverProjectConfig(event.cwd)
          : undefined;
        // Scope credential resolution to the SESSION project's `.me` (from the
        // event cwd), not the hook process cwd: resolveCredentials() otherwise
        // re-discovers `.me` from process.cwd(), so the login check + server/
        // space fallback could reflect a different project. Seeding the override
        // keeps routing deterministic.
        if (project) setConfigDirOverride(project.dir);
        // Don't pass the `.me` server explicitly: let resolveCredentials() →
        // resolveServer() resolve (and whitelist-validate) it, so an untrusted
        // `.me` server can't slip in here and receive credentials.
        const creds = resolveCredentials();
        // The hook ships inert: exit 0 SILENTLY when capture is off — a
        // deliberate opt-out, distinct from the "no credentials" error below.
        // Checked BEFORE resolving the agent below, so a project with capture
        // off but no agent configured stays silent rather than logging a
        // resolution error it doesn't need.
        const projectConfig = {
          space: project?.space,
          tree: project?.tree,
          capture: project?.capture,
        };
        if (!resolveCaptureEnabled(creds, projectConfig)) {
          process.exit(0);
        }
        // Capture is a harness surface like MCP, so it resolves the agent
        // ambiently (project agent: → global agent:) rather than the
        // explicit-only `creds.asAgent` — an unresolvable agent throws here,
        // into the catch below (capture skips), instead of silently writing
        // as the human.
        config = resolveHookConfigFromEnv(
          process.env,
          { ...creds, asAgent: resolveHarnessAgent() },
          projectConfig,
        );
      } catch (error) {
        console.error(
          `[memory-engine] ${eventName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(0);
      }
      if (!config) {
        // resolveHookConfigFromEnv returns null for a missing bearer OR a
        // missing space — name both so the fix is actionable either way.
        console.error(
          "[memory-engine] missing credentials or space. Run `me login` and " +
            "`me space use <space>`, or configure api_key + space via " +
            "`/plugin` in Claude Code.",
        );
        process.exit(0);
      }

      // Import the transcript (incremental; same path as `me import claude`).
      try {
        const client = createMemoryClient({
          url: config.server,
          ...memoryBearer(config.server, config.apiKey),
          space: config.space,
          asAgent: config.asAgent,
        });
        await importTranscriptFile(client, claudeImporter, transcriptPath, {
          treeRoot: config.treeRoot,
          tree: config.tree,
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

/**
 * Parse `claude plugin list --json` output and report whether the Memory
 * Engine plugin is installed. Exported for tests. Unparseable output counts
 * as not-installed — the wrong guess costs an idempotent re-install offer,
 * never a missed install.
 */
export function pluginListShowsInstalled(stdout: string): boolean {
  try {
    const plugins = JSON.parse(stdout);
    if (!Array.isArray(plugins)) return false;
    return plugins.some((p) => (p as { id?: unknown }).id === PLUGIN_REF);
  } catch {
    return false;
  }
}

/**
 * Availability of the plugin-install init step: hidden when the `claude`
 * binary is absent, "done" when the plugin is already installed. Also used by
 * the `me project init` preflight.
 */
export async function pluginInstallAvailable(): Promise<StepAvailability> {
  if (Bun.which("claude") === null) return "hidden";
  const { exitCode, stdout } = await runCommand([
    "claude",
    "plugin",
    "list",
    "--json",
  ]);
  if (exitCode !== 0) return "available"; // can't tell → offer the install
  return pluginListShowsInstalled(stdout) ? "done" : "available";
}

export function createClaudeCommand(): Command {
  const claude = new Command("claude").description("Claude Code integration");
  claude.addCommand(createClaudeInstallCommand());
  // `me claude init` is retired in favor of the harness-agnostic
  // `me project init`; a deprecated alias (registered by index.ts to avoid a
  // module cycle with project.ts) warns and delegates for one release.
  claude.addCommand(createClaudeEnvCommand());
  claude.addCommand(createClaudeHookCommand());
  claude.addCommand(createClaudeImportCommand());
  return claude;
}
