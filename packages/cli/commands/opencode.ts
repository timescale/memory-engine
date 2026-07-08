/**
 * me opencode — OpenCode integration commands.
 *
 * - me opencode install: register me as an MCP server with OpenCode
 * - me opencode init:    one-shot per-project setup (backfill + plugin + MCP + AGENTS.md)
 * - me opencode hook:    invoked by the OpenCode plugin to capture a session
 * - me opencode import:  bulk-import OpenCode session history
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  applyCaptureDeselection,
  captureEnableStep,
} from "../agent/capture-step.ts";
import { ensureDefaultAgent } from "../agent/default-agent.ts";
import {
  buildInitCommand,
  DIM,
  DIM_OFF,
  type InitStep,
  type InitStepContext,
  initOutroLead,
  type StepAvailability,
} from "../agent/init.ts";
import {
  type MemoryPointerSpec,
  memoryPointerUpToDate,
  writeMemoryPointer,
} from "../agent/memory-pointer.ts";
import { createMemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { importTranscriptFile } from "../importers/index.ts";
import { opencodeImporter, resolveSessionFile } from "../importers/opencode.ts";
import { SlugRegistry } from "../importers/slug.ts";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";
import {
  ASSET_MARKER,
  RECALL_COMMAND_FILENAME,
  renderRecallCommand,
  renderSkill,
  SKILL_FILENAME,
  SKILL_NAME,
} from "../opencode/assets.ts";
import {
  HOOK_EVENT_NAMES,
  type HookEventName,
  resolveHookConfig,
  SESSIONS_NODE,
} from "../opencode/capture.ts";
import {
  PLUGIN_FILENAME,
  PLUGIN_MARKER,
  renderPluginSource,
} from "../opencode/plugin-template.ts";
import {
  type OpenCodeScope,
  openCodeCommandsDir,
  openCodePluginsDir,
  openCodeSkillsDir,
  parseScope,
} from "../opencode/scope.ts";
import {
  discoverProjectConfig,
  setConfigDirOverride,
} from "../project-config.ts";
import { memoryBearer } from "../session.ts";
import { runCapturePrompt } from "./capture-prompt.ts";
import { createOpenCodeImportCommand, runAgentImport } from "./import.ts";
import { runGitImport } from "./import-git.ts";
import { gitHookStatus, runGitHookInstall } from "./import-git-hook.ts";

/** The managed AGENTS.md memory-pointer block `me opencode init` upserts. */
const AGENTS_MD_POINTER: MemoryPointerSpec = {
  filename: "AGENTS.md",
  managedBy: "me opencode init",
  agentLabel: "OpenCode",
};

/** Absolute path of the generated capture plugin for a scope. */
function openCodePluginPath(scope: OpenCodeScope, projectRoot: string): string {
  return join(openCodePluginsDir(scope, projectRoot), PLUGIN_FILENAME);
}

/** Whether our managed capture plugin is already installed (by its marker). */
async function openCodePluginInstalled(
  scope: OpenCodeScope,
  projectRoot: string,
): Promise<boolean> {
  try {
    const existing = await readFile(
      openCodePluginPath(scope, projectRoot),
      "utf8",
    );
    return existing.startsWith(PLUGIN_MARKER);
  } catch {
    return false;
  }
}

/** Write (or refresh) the generated capture plugin into the scoped plugins dir. */
async function installOpenCodePlugin(
  scope: OpenCodeScope,
  projectRoot: string,
): Promise<void> {
  const dir = openCodePluginsDir(scope, projectRoot);
  await mkdir(dir, { recursive: true });
  const file = openCodePluginPath(scope, projectRoot);
  await writeFile(file, renderPluginSource());
  clack.log.success(`Installed the OpenCode capture plugin → ${file}`);
}

/** Whether a managed asset file already carries our marker. */
async function assetInstalled(path: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).includes(ASSET_MARKER);
  } catch {
    return false;
  }
}

const recallCommandPath = (scope: OpenCodeScope, projectRoot: string): string =>
  join(openCodeCommandsDir(scope, projectRoot), RECALL_COMMAND_FILENAME);

const skillPath = (scope: OpenCodeScope, projectRoot: string): string =>
  join(openCodeSkillsDir(scope, projectRoot), SKILL_NAME, SKILL_FILENAME);

/** Write (or refresh) the `/memory-recall` command into the scoped commands dir. */
async function installRecallCommand(
  scope: OpenCodeScope,
  projectRoot: string,
): Promise<void> {
  const file = recallCommandPath(scope, projectRoot);
  await mkdir(openCodeCommandsDir(scope, projectRoot), { recursive: true });
  await writeFile(file, renderRecallCommand());
  clack.log.success(`Installed the /memory-recall command → ${file}`);
}

/** Write (or refresh) the `memory-engine` skill into the scoped skills dir. */
async function installSkill(
  scope: OpenCodeScope,
  projectRoot: string,
): Promise<void> {
  const file = skillPath(scope, projectRoot);
  await mkdir(join(openCodeSkillsDir(scope, projectRoot), SKILL_NAME), {
    recursive: true,
  });
  await writeFile(file, renderSkill());
  clack.log.success(`Installed the ${SKILL_NAME} skill → ${file}`);
}

/** Resolve the project root (git root, else cwd) for `scope: "project"`. */
async function resolveProjectRoot(): Promise<string> {
  const { gitRoot } = await new SlugRegistry().resolve(process.cwd());
  return gitRoot ?? process.cwd();
}

/**
 * me opencode install — register the MCP server, install the (inert) capture
 * plugin, and run the shared capture opt-in — mirroring `me claude install`'s
 * one-install model. A headless (api-key) install stops after the MCP
 * registration: capture is credential-agnostic, so a headless deployment opts
 * in via a committed `.me` `capture: true` or the target machine's config.
 */
function createOpenCodeInstallCommand(): Command {
  return new Command("install")
    .description(
      "set up OpenCode: MCP server + capture plugin (asks about capture)",
    )
    .option(
      "--api-key <key>",
      "API key for a headless agent (default: use your login session at runtime)",
    )
    .option("--server <url>", "server URL to embed in MCP config")
    .option(
      "--space <slug>",
      "pin a space (default: resolve ME_SPACE / active space at runtime)",
    )
    .option(
      "--scope <scope>",
      "where to write the MCP config: project (./opencode.json) or user (~/.config/opencode) [default: user]",
      (v) => parseScope(v),
    )
    .option(
      "--no-default-agent",
      "skip provisioning a default agent (agent: coder) for this install",
    )
    .action(
      async (
        opts: AgentInstallOptions & {
          scope?: OpenCodeScope;
          defaultAgent?: boolean;
        },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        const scope = opts.scope ?? "user";
        await runAgentMcpInstall("opencode", {
          apiKey: opts.apiKey,
          server: globalOpts.server ?? opts.server,
          space: opts.space,
          scope,
          projectDir:
            scope === "project" ? await resolveProjectRoot() : undefined,
        });

        const creds = resolveCredentials(globalOpts.server ?? opts.server);
        const headless = Boolean(opts.apiKey ?? creds.apiKey);
        if (headless) return;

        const activeSpace = opts.space ?? creds.activeSpace;
        if (opts.defaultAgent !== false) {
          await ensureDefaultAgent({ ...creds, activeSpace });
        }

        // The one user-scoped capture plugin — inert until capture is enabled
        // (the flag below, or a project's `.me` `capture: true`).
        await installOpenCodePlugin("user", process.cwd());

        // Capture opt-in (shared with `me claude install`): prompt, persist
        // the machine-wide flag, and backfill existing sessions on yes.
        await runCapturePrompt(opencodeImporter, globalOpts, {
          space: activeSpace,
          toolLabel: "OpenCode",
          installCmd: "me opencode install",
        });
      },
    );
}

/**
 * me opencode hook — invoked by the OpenCode plugin on session.idle /
 * session.deleted to capture the session.
 *
 * The plugin runs in-process JS and forwards the session id (not a transcript
 * path), so this command resolves the id to its storage file and runs it through
 * `importTranscriptFile` — the same parse + write as `me import opencode`,
 * incremental so each call only writes messages new since the last.
 *
 * Best-effort: logs failures to stderr but always exits 0 so a hook failure never
 * blocks an OpenCode session.
 */
function createOpenCodeHookCommand(): Command {
  return new Command("hook")
    .description("invoked by the OpenCode plugin to capture a session")
    .requiredOption(
      "--event <name>",
      `hook event name (${HOOK_EVENT_NAMES.join(", ")})`,
    )
    .requiredOption("--session <id>", "OpenCode session id (e.g. ses_abc123)")
    .option(
      "--storage <dir>",
      "OpenCode storage dir (default: standard location)",
    )
    .option(
      "--project-dir <dir>",
      "the session's project dir (anchor for .me/config.yaml discovery; passed by the generated plugin)",
    )
    .option(
      "--full-transcript",
      "also store reasoning + tool calls/results (default: prompts + responses)",
    )
    .action(
      async (
        opts: {
          event: string;
          session: string;
          storage?: string;
          projectDir?: string;
          fullTranscript?: boolean;
        },
        cmd: Command,
      ) => {
        const eventName = opts.event as HookEventName;
        if (!HOOK_EVENT_NAMES.includes(eventName)) {
          console.error(
            `[memory-engine] unknown event '${opts.event}'. Expected one of: ${HOOK_EVENT_NAMES.join(", ")}`,
          );
          process.exit(0);
        }

        const globalOpts = cmd.optsWithGlobals();
        // `.me` server/space/tree come via resolveCredentials, scoped to the
        // session's own project dir (explicit --project-dir from the plugin,
        // matching the Claude hook's explicit-anchor approach) — falling back
        // to a cwd walk-up when absent (an older plugin, or a direct manual
        // call). A broken `.me` is fatal for direct CLI use, but the hook is
        // best-effort: log + exit 0 so a typo never blocks capture.
        let config: ReturnType<typeof resolveHookConfig>;
        try {
          const project = opts.projectDir
            ? discoverProjectConfig(opts.projectDir)
            : undefined;
          if (project) setConfigDirOverride(project.dir);
          const creds = resolveCredentials(globalOpts.server);
          // The hook ships inert — the ONE capture model shared with Claude:
          // project `.me` `capture` > the machine-wide flag > off (both folded
          // into `captureEnabled`). A deliberate opt-out exits 0 SILENTLY,
          // distinct from the "no credentials" error below.
          if (!creds.captureEnabled) process.exit(0);
          config = resolveHookConfig(creds, {
            fullTranscript: opts.fullTranscript,
          });
        } catch (error) {
          console.error(
            `[memory-engine] ${eventName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(0);
        }
        if (!config) {
          // resolveHookConfig returns null for a missing bearer OR a missing
          // space — name both so the fix is actionable either way.
          console.error(
            "[memory-engine] missing credentials or space. Run `me login` and " +
              "`me space use <space>`, or set ME_API_KEY + ME_SPACE.",
          );
          process.exit(0);
        }

        // Resolve the session id to its storage file (id alone needs a lookup
        // across project dirs).
        const sessionFile = await resolveSessionFile(
          opts.session,
          opts.storage,
        );
        if (!sessionFile) {
          console.error(
            `[memory-engine] ${eventName}: session '${opts.session}' not found in OpenCode storage`,
          );
          process.exit(0);
        }

        // Import the session (incremental; same path as `me import opencode`).
        try {
          const client = createMemoryClient({
            url: config.server,
            ...memoryBearer(config.server, config.apiKey),
            space: config.space,
            asAgent: config.asAgent,
          });
          await importTranscriptFile(client, opencodeImporter, sessionFile, {
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
      },
    );
}

/**
 * me opencode init — one-shot setup of OpenCode memory integration.
 *
 * Mirrors `me claude init` on the shared init engine: a grouped, pre-checked
 * step picker (or, non-interactively, every step minus its `--skip-*` flag).
 * The steps differ from Claude's because OpenCode capture is a generated local
 * plugin (not a marketplace plugin) and MCP registration is a separate step.
 */
/** Read the resolved scope + project root from the init context (defaults to
 * project / cwd if resolveContext somehow didn't run). */
function scopeOf(ctx: InitStepContext): {
  scope: OpenCodeScope;
  projectRoot: string;
} {
  return {
    scope: (ctx.scope as OpenCodeScope) ?? "project",
    projectRoot: ctx.projectRoot ?? process.cwd(),
  };
}

const INIT_STEPS: InitStep[] = [
  {
    id: "session-import",
    group: "OpenCode sessions",
    kind: "backfill",
    optionKey: "skipSessionImport",
    skipFlag: "--skip-session-import",
    skipDescription: "do not import this project's OpenCode sessions",
    label:
      "Import this project's existing OpenCode sessions (one-time backfill)",
    // Scope the backfill to sessions recorded in this repo (cwd at or under the
    // repo root); `me import opencode` remains the machine-wide sweep. Include
    // temp-cwd sessions since the scope is already pinned to this project.
    run: async (ctx) => {
      const { projectRoot } = scopeOf(ctx);
      await runAgentImport(
        opencodeImporter,
        { project: projectRoot, includeTempCwd: true },
        ctx.globalOpts,
      );
    },
  },
  {
    id: "plugin-install",
    group: "OpenCode sessions",
    kind: "ongoing",
    optionKey: "skipPluginInstall",
    skipFlag: "--skip-plugin-install",
    skipDescription: "do not install the OpenCode capture plugin",
    label:
      "Install the OpenCode capture plugin — captures new sessions going forward",
    // ✓ when our managed plugin file is already present; a re-run refreshes it.
    available: async (ctx) => {
      const { scope, projectRoot } = scopeOf(ctx);
      return (await openCodePluginInstalled(scope, projectRoot))
        ? "done"
        : "available";
    },
    doneLabel: "OpenCode capture plugin already installed",
    rerunLabel:
      "Reinstall the OpenCode capture plugin — captures new sessions going forward (already installed)",
    // Plugin only — inert until capture is enabled; the capture-enable step
    // below is the per-project opt-in.
    run: (ctx) => {
      const { scope, projectRoot } = scopeOf(ctx);
      return installOpenCodePlugin(scope, projectRoot);
    },
  },
  captureEnableStep({ group: "OpenCode sessions", toolLabel: "OpenCode" }),
  {
    id: "mcp-install",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipMcpInstall",
    skipFlag: "--skip-mcp-install",
    skipDescription: "do not register me as an MCP server with OpenCode",
    label:
      "Register me as an MCP server — gives OpenCode the memory search/create tools",
    run: (ctx) => {
      const { scope, projectRoot } = scopeOf(ctx);
      return runAgentMcpInstall("opencode", {
        server: ctx.server,
        scope,
        projectDir: scope === "project" ? projectRoot : undefined,
      });
    },
  },
  {
    id: "recall-command",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipRecallCommand",
    skipFlag: "--skip-recall-command",
    skipDescription: "do not install the /memory-recall command",
    label: "Install the /memory-recall command",
    available: async (ctx) => {
      const { scope, projectRoot } = scopeOf(ctx);
      return (await assetInstalled(recallCommandPath(scope, projectRoot)))
        ? "done"
        : "available";
    },
    doneLabel: "/memory-recall command already installed",
    rerunLabel: "Rewrite the /memory-recall command (already installed)",
    run: (ctx) => {
      const { scope, projectRoot } = scopeOf(ctx);
      return installRecallCommand(scope, projectRoot);
    },
  },
  {
    id: "skill",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipSkill",
    skipFlag: "--skip-skill",
    skipDescription: "do not install the memory-engine skill",
    label: "Install the memory-engine skill (teaches when/how to use memory)",
    available: async (ctx) => {
      const { scope, projectRoot } = scopeOf(ctx);
      return (await assetInstalled(skillPath(scope, projectRoot)))
        ? "done"
        : "available";
    },
    doneLabel: "memory-engine skill already installed",
    rerunLabel: "Rewrite the memory-engine skill (already installed)",
    run: (ctx) => {
      const { scope, projectRoot } = scopeOf(ctx);
      return installSkill(scope, projectRoot);
    },
  },
  {
    id: "git-import",
    group: "Git history",
    kind: "backfill",
    optionKey: "skipGitImport",
    skipFlag: "--skip-git-import",
    skipDescription: "do not import the repo's git commit history",
    label: "Import existing git commit history (one-time backfill)",
    run: ({ globalOpts }) => runGitImport({ skipIfNotRepo: true }, globalOpts),
  },
  {
    id: "git-hook",
    group: "Git history",
    kind: "ongoing",
    optionKey: "skipGitHook",
    skipFlag: "--skip-git-hook",
    skipDescription: "do not install the git post-commit capture hook",
    label:
      "Install a git post-commit hook — captures new commits going forward",
    available: async () => {
      const status = await gitHookStatus(process.cwd());
      if (status === "installed") return "done";
      return status === "installable" ? "available" : "hidden";
    },
    doneLabel: "Git post-commit hook already installed",
    rerunLabel:
      "Reinstall the git post-commit hook — captures new commits going forward (already installed)",
    run: ({ globalOpts }) =>
      runGitHookInstall({ skipIfNotRepo: true }, globalOpts),
  },
  {
    id: "agents-md",
    group: "Project config",
    kind: "config",
    optionKey: "skipAgentsMd",
    skipFlag: "--skip-agents-md",
    skipDescription:
      "do not write the memory pointer into the project's AGENTS.md",
    label: "Add a memory pointer to AGENTS.md",
    available: async ({ server }) =>
      (await memoryPointerUpToDate(AGENTS_MD_POINTER, server))
        ? "done"
        : ("available" satisfies StepAvailability),
    doneLabel: "Memory pointer already in AGENTS.md",
    rerunLabel: "Rewrite the memory pointer in AGENTS.md (already present)",
    run: ({ server }) => writeMemoryPointer(AGENTS_MD_POINTER, server),
  },
];

/** Closing guidance after `me opencode init` — recap + how to use memories. */
function printInitOutro(steps: InitStep[]): void {
  clack.note(
    [
      ...initOutroLead(steps),
      "Ask OpenCode about this project's history or architecture — it now",
      "draws on the project's memories through the `me_memory_search` tool,",
      "and consults them when exploring the code for new features.",
      "",
      "You can also point OpenCode at them explicitly, e.g.:",
      `${DIM}"Search memory engine: why did we structure the database this way?"${DIM_OFF}`,
      `${DIM}"Check me memories for past work on this area before we start"${DIM_OFF}`,
    ].join("\n"),
    "Your project now has memory",
  );
}

/**
 * Resolve the install scope for `me opencode init`: an explicit `--scope`
 * (validated by the option's arg parser) wins; otherwise prompt in an
 * interactive terminal (project preselected), and default to project when
 * non-interactive. Also resolves the project root once for project-scoped steps.
 */
async function resolveOpenCodeInitContext(
  base: InitStepContext,
  cmdOpts: Record<string, unknown>,
  { interactive }: { interactive: boolean },
): Promise<InitStepContext> {
  const projectRoot = await resolveProjectRoot();
  // The --scope arg parser already validated + narrowed the value.
  let scope = cmdOpts.scope as OpenCodeScope | undefined;
  if (!scope) {
    if (interactive) {
      const picked = await clack.select<OpenCodeScope>({
        message: "Install scope",
        options: [
          {
            value: "project",
            label: "Project",
            hint: ".opencode/ + opencode.json — commit to share with your team",
          },
          {
            value: "user",
            label: "User (global)",
            hint: "~/.config/opencode/ — just for you, across all projects",
          },
        ],
        initialValue: "project",
      });
      if (clack.isCancel(picked)) {
        clack.cancel("Cancelled.");
        process.exit(0);
      }
      scope = picked;
    } else {
      scope = "project";
    }
  }
  return { ...base, scope, projectRoot };
}

function createOpenCodeInitCommand(): Command {
  return buildInitCommand({
    description:
      "set up OpenCode memory integration (interactive step picker; otherwise runs all steps)",
    steps: INIT_STEPS,
    outro: printInitOutro,
    options: [
      {
        flags: "--scope <scope>",
        description:
          "install scope: project (.opencode/) or user (~/.config/opencode) [default: project; prompted in a TTY]",
        argParser: (v) => parseScope(v),
      },
    ],
    resolveContext: resolveOpenCodeInitContext,
    // Interactively deselecting the capture row is an explicit per-project
    // opt-out — write `capture: false` (see applyCaptureDeselection).
    afterRun: (result, ctx, { interactive }) =>
      applyCaptureDeselection(result, {
        interactive,
        projectRoot: ctx.projectRoot,
      }),
  });
}

export function createOpenCodeCommand(): Command {
  const opencode = new Command("opencode").description("OpenCode integration");
  opencode.addCommand(createOpenCodeInstallCommand());
  opencode.addCommand(createOpenCodeInitCommand());
  opencode.addCommand(createOpenCodeHookCommand());
  opencode.addCommand(createOpenCodeImportCommand());
  return opencode;
}
