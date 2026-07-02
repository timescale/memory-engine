/**
 * me opencode — OpenCode integration commands.
 *
 * Two scopes, two commands (HARNESS_INTEGRATION_DESIGN.md §3.2):
 *   - `me opencode install`: USER scope (`~/.config/opencode/`) — acts as the
 *     human. MCP + capture plugin + skill + /memory-recall command + a user
 *     context snippet in `~/.config/opencode/AGENTS.md`. No agent mode, no env
 *     injection. Optional `--server`/`--space` pins (§5).
 *   - `me opencode init`: PROJECT scope (`.opencode/` + repo `opencode.json` /
 *     `AGENTS.md`) — acts as the project's `.me` agent. Everything install does
 *     plus `--as-agent .me` on the MCP + hook commands, a `shell.env` injecting
 *     `ME_AS_AGENT=.me`, the git post-commit hook, and one-time backfills.
 *     Requires a `.me/config.yaml` with an `agent:` (fail-fast).
 *   - `me opencode hook`: invoked by the generated plugin to capture a session.
 *   - `me opencode import`: bulk-import OpenCode session history.
 */
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ASSET_MARKER,
  type AssetRenderOptions,
  projectSnippetMarkers,
  RECALL_COMMAND_FILENAME,
  renderProjectContextSnippet,
  renderRecallCommand,
  renderSkill,
  renderUserContextSnippet,
  SKILL_FILENAME,
  SKILL_NAME,
  userSnippetMarkers,
} from "../agent/assets.ts";
import { parseHookScope, runCaptureHook } from "../agent/capture.ts";
import {
  buildInitCommand,
  DIM,
  DIM_OFF,
  type InitStep,
  type InitStepContext,
  initOutroLead,
  requireProjectAgent,
  type StepAvailability,
} from "../agent/init.ts";
import {
  managedFileInstalled,
  removeBlockFromFile,
  removeManagedFile,
  type UpsertOutcome,
  updateJsonFile,
  upsertBlockInFile,
  writeManagedFile,
} from "../agent/managed.ts";
import { resolveCredentials } from "../credentials.ts";
import { DEFAULT_TREE_ROOT } from "../importers/index.ts";
import { opencodeImporter, resolveSessionFile } from "../importers/opencode.ts";
import { SlugRegistry } from "../importers/slug.ts";
import {
  buildMeCommand,
  installMcpServer,
  MCP_TOOLS,
  openCodeConfigPath,
} from "../mcp/install.ts";
import {
  PLUGIN_FILENAME,
  PLUGIN_MARKER,
  renderPluginSource,
} from "../opencode/plugin-template.ts";
import {
  type OpenCodeScope,
  openCodeBaseDir,
  openCodeCommandsDir,
  openCodePluginsDir,
  openCodeSkillsDir,
} from "../opencode/scope.ts";
import { createOpenCodeImportCommand, runAgentImport } from "./import.ts";
import { runGitImport } from "./import-git.ts";
import { gitHookStatus, runGitHookInstall } from "./import-git-hook.ts";

/** OpenCode capture events forwarded by the generated plugin. */
const HOOK_EVENT_NAMES = ["idle", "deleted"] as const;
type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

// =============================================================================
// Scoped asset paths
// =============================================================================

const pluginFile = (scope: OpenCodeScope, root: string): string =>
  join(openCodePluginsDir(scope, root), PLUGIN_FILENAME);
const skillFile = (scope: OpenCodeScope, root: string): string =>
  join(openCodeSkillsDir(scope, root), SKILL_NAME, SKILL_FILENAME);
const recallFile = (scope: OpenCodeScope, root: string): string =>
  join(openCodeCommandsDir(scope, root), RECALL_COMMAND_FILENAME);
/** Context file: repo `AGENTS.md` (project) vs `~/.config/opencode/AGENTS.md`
 * (user — the global rules file OpenCode reads). */
const contextFile = (scope: OpenCodeScope, root: string): string =>
  scope === "project"
    ? join(root, "AGENTS.md")
    : join(openCodeBaseDir("user", root), "AGENTS.md");

/** Human verb for an upsert outcome. */
function verb(o: UpsertOutcome): string {
  return o === "installed"
    ? "Installed"
    : o === "updated"
      ? "Updated"
      : "Already up to date:";
}

const renderOpts = (scope: OpenCodeScope): AssetRenderOptions => ({
  agentMode: scope === "project",
});

// =============================================================================
// Scoped asset installers (shared by install + init)
// =============================================================================

async function installPlugin(
  scope: OpenCodeScope,
  root: string,
): Promise<void> {
  const file = pluginFile(scope, root);
  const outcome = await writeManagedFile(
    file,
    renderPluginSource({ scope }),
    PLUGIN_MARKER,
  );
  clack.log.success(`${verb(outcome)} the OpenCode capture plugin → ${file}`);
}

async function installSkill(scope: OpenCodeScope, root: string): Promise<void> {
  const file = skillFile(scope, root);
  const outcome = await writeManagedFile(
    file,
    renderSkill(renderOpts(scope)),
    ASSET_MARKER,
  );
  clack.log.success(`${verb(outcome)} the ${SKILL_NAME} skill → ${file}`);
}

async function installRecall(
  scope: OpenCodeScope,
  root: string,
): Promise<void> {
  const file = recallFile(scope, root);
  const outcome = await writeManagedFile(
    file,
    renderRecallCommand(),
    ASSET_MARKER,
  );
  clack.log.success(`${verb(outcome)} the /memory-recall command → ${file}`);
}

/** Resolve the project context-snippet facts from `.me` + the repo. */
async function projectFacts(
  root: string,
  server?: string,
): Promise<Parameters<typeof renderProjectContextSnippet>[0]> {
  const creds = resolveCredentials(server);
  const { slug } = await new SlugRegistry().resolve(root);
  return {
    projectTree: creds.projectTree ?? `${DEFAULT_TREE_ROOT}.${slug}`,
    space: creds.activeSpace,
    agentMode: true,
  };
}

async function installContextSnippet(
  scope: OpenCodeScope,
  root: string,
  server?: string,
): Promise<void> {
  const file = contextFile(scope, root);
  if (scope === "user") {
    const outcome = await upsertBlockInFile(
      file,
      renderUserContextSnippet(),
      userSnippetMarkers(),
    );
    clack.log.success(`${verb(outcome)} the memory pointer → ${file}`);
    return;
  }
  const block = renderProjectContextSnippet(await projectFacts(root, server));
  const outcome = await upsertBlockInFile(file, block, projectSnippetMarkers());
  clack.log.success(`${verb(outcome)} the project memory pointer → ${file}`);
}

/** Whether the project context snippet is already current (idempotent step). */
async function contextSnippetUpToDate(
  root: string,
  server?: string,
): Promise<boolean> {
  const block = renderProjectContextSnippet(await projectFacts(root, server));
  try {
    return (await Bun.file(contextFile("project", root)).text()).includes(
      block,
    );
  } catch {
    return false;
  }
}

// =============================================================================
// MCP registration (json-file) — scope-aware, agent-mode + pins
// =============================================================================

const openCodeTool = () => {
  const tool = MCP_TOOLS.find((t) => t.bin === "opencode");
  if (!tool) throw new Error("opencode tool missing from MCP_TOOLS");
  return tool;
};

async function installMcp(
  scope: OpenCodeScope,
  root: string,
  pins: { server?: string; space?: string } = {},
): Promise<void> {
  const meCmd = buildMeCommand({
    asAgent: scope === "project" ? ".me" : undefined,
    server: pins.server,
    space: pins.space,
  });
  const result = await installMcpServer(openCodeTool(), meCmd, {
    scope,
    projectDir: scope === "project" ? root : undefined,
  });
  if (result.success) clack.log.success(result.message);
  else {
    clack.log.error(result.message);
    process.exit(1);
  }
}

/** Remove our `mcp.me` entry from the scoped opencode.json (if present). */
async function removeMcp(scope: OpenCodeScope, root: string): Promise<void> {
  const path = openCodeConfigPath({
    scope,
    projectDir: scope === "project" ? root : undefined,
  });
  await updateJsonFile(path, (config) => {
    const mcp = config.mcp;
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      delete (mcp as Record<string, unknown>).me;
    }
    return config;
  }).catch(() => {}); // absent config → nothing to remove
}

// =============================================================================
// me opencode install (USER scope)
// =============================================================================

function createOpenCodeInstallCommand(): Command {
  return new Command("install")
    .description(
      "set up the OpenCode integration for your user (MCP + capture + skill + command)",
    )
    .option(
      "--server <url>",
      "pin a server for the MCP config (implies your login session for it)",
    )
    .option(
      "--space <slug>",
      "pin a space for the MCP config (implies --server)",
    )
    .option("--remove", "remove the user-scope OpenCode integration")
    .action(
      async (
        opts: { server?: string; space?: string; remove?: boolean },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        const server = globalOpts.server ?? opts.server ?? undefined;
        const root = process.cwd(); // user scope ignores it, but keep the API uniform
        const scope: OpenCodeScope = "user";

        if (opts.remove) {
          await removeMcp(scope, root);
          await removeManagedFile(pluginFile(scope, root), PLUGIN_MARKER);
          await removeManagedFile(skillFile(scope, root), ASSET_MARKER);
          await removeManagedFile(recallFile(scope, root), ASSET_MARKER);
          await removeBlockFromFile(
            contextFile(scope, root),
            userSnippetMarkers(),
          );
          clack.log.success("Removed the user-scope OpenCode integration.");
          return;
        }

        const creds = resolveCredentials(server);
        if (!creds.apiKey && !creds.loggedIn) {
          clack.log.error(
            "Not logged in. Run 'me login' first (or set ME_API_KEY for a headless install).",
          );
          process.exit(1);
        }
        // Resolve opt-in pins (§5): --space implies --server; a pin needs a
        // session for that server.
        let pins: { server?: string; space?: string } = {};
        if (opts.server || opts.space) {
          if (!creds.loggedIn) {
            clack.log.error(
              "Pinning --server/--space requires a login session for that server. Run 'me login' first.",
            );
            process.exit(1);
          }
          pins = opts.space
            ? { server: opts.server ?? creds.server, space: opts.space }
            : { server: opts.server };
        }

        await installMcp(scope, root, pins);
        await installPlugin(scope, root);
        await installSkill(scope, root);
        await installRecall(scope, root);
        await installContextSnippet(scope, root, server);
        clack.log.success(
          "OpenCode is set up for your user. New sessions are captured to Memory Engine.",
        );
      },
    );
}

// =============================================================================
// me opencode hook (capture) — thin adapter on the shared runner
// =============================================================================

function createOpenCodeHookCommand(): Command {
  return new Command("hook")
    .description("invoked by the OpenCode plugin to capture a session")
    .requiredOption(
      "--event <name>",
      `hook event name (${HOOK_EVENT_NAMES.join(", ")})`,
    )
    .requiredOption("--session <id>", "OpenCode session id (e.g. ses_abc123)")
    .option(
      "--scope <scope>",
      "install scope that authored this hook (user|project)",
    )
    .option(
      "--storage <dir>",
      "OpenCode storage dir (default: standard location)",
    )
    .option(
      "--tree-root <ltree>",
      "tree root for captures (default: share.projects)",
    )
    .option(
      "--full-transcript",
      "also store reasoning + tool calls/results (default: prompts + responses)",
    )
    .action(
      async (opts: {
        event: string;
        session: string;
        scope?: string;
        storage?: string;
        treeRoot?: string;
        fullTranscript?: boolean;
      }) => {
        const eventName = opts.event as HookEventName;
        if (!HOOK_EVENT_NAMES.includes(eventName)) {
          console.error(
            `[memory-engine] unknown event '${opts.event}'. Expected one of: ${HOOK_EVENT_NAMES.join(", ")}`,
          );
          process.exit(0);
        }

        // Resolve the session id to its storage file (id alone needs a lookup
        // across project dirs). No transcript → nothing to capture.
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

        await runCaptureHook({
          harness: "opencode",
          event: eventName,
          scope: parseHookScope(opts.scope),
          transcriptPath: sessionFile,
          projectCwd: process.cwd(),
          importer: opencodeImporter,
          projectCaptureInstalled: (projectRoot) =>
            managedFileInstalled(
              pluginFile("project", projectRoot),
              PLUGIN_MARKER,
            ),
          input: {
            treeRoot: opts.treeRoot,
            fullTranscript: opts.fullTranscript,
          },
        });
        process.exit(0);
      },
    );
}

// =============================================================================
// me opencode init (PROJECT scope)
// =============================================================================

/** Resolve the project root (git root, else cwd). */
async function resolveProjectRoot(): Promise<string> {
  const { gitRoot } = await new SlugRegistry().resolve(process.cwd());
  return gitRoot ?? process.cwd();
}

const projectRootOf = (ctx: InitStepContext): string =>
  ctx.projectRoot ?? process.cwd();

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
    run: async (ctx) => {
      await runAgentImport(
        opencodeImporter,
        { project: projectRootOf(ctx), includeTempCwd: true },
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
    available: async (ctx) =>
      (await managedFileInstalled(
        pluginFile("project", projectRootOf(ctx)),
        PLUGIN_MARKER,
      ))
        ? "done"
        : "available",
    doneLabel: "OpenCode capture plugin already installed",
    rerunLabel:
      "Reinstall the OpenCode capture plugin — captures new sessions going forward (already installed)",
    run: (ctx) => installPlugin("project", projectRootOf(ctx)),
  },
  {
    id: "mcp-install",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipMcpInstall",
    skipFlag: "--skip-mcp-install",
    skipDescription: "do not register me as an MCP server with OpenCode",
    label:
      "Register me as an MCP server — gives OpenCode the memory search/create tools",
    run: (ctx) => installMcp("project", projectRootOf(ctx)),
  },
  {
    id: "recall-command",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipRecallCommand",
    skipFlag: "--skip-recall-command",
    skipDescription: "do not install the /memory-recall command",
    label: "Install the /memory-recall command",
    available: async (ctx) =>
      (await managedFileInstalled(
        recallFile("project", projectRootOf(ctx)),
        ASSET_MARKER,
      ))
        ? "done"
        : "available",
    doneLabel: "/memory-recall command already installed",
    rerunLabel: "Rewrite the /memory-recall command (already installed)",
    run: (ctx) => installRecall("project", projectRootOf(ctx)),
  },
  {
    id: "skill",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipSkill",
    skipFlag: "--skip-skill",
    skipDescription: "do not install the memory-engine skill",
    label: "Install the memory-engine skill (teaches when/how to use memory)",
    available: async (ctx) =>
      (await managedFileInstalled(
        skillFile("project", projectRootOf(ctx)),
        ASSET_MARKER,
      ))
        ? "done"
        : "available",
    doneLabel: "memory-engine skill already installed",
    rerunLabel: "Rewrite the memory-engine skill (already installed)",
    run: (ctx) => installSkill("project", projectRootOf(ctx)),
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
    // Project scope: imported commits are written as the project's agent.
    run: ({ globalOpts }) =>
      runGitHookInstall({ skipIfNotRepo: true, asAgent: ".me" }, globalOpts),
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
      (await contextSnippetUpToDate(await resolveProjectRoot(), server))
        ? "done"
        : ("available" satisfies StepAvailability),
    doneLabel: "Memory pointer already in AGENTS.md",
    rerunLabel: "Rewrite the memory pointer in AGENTS.md (already present)",
    run: (ctx) =>
      installContextSnippet("project", projectRootOf(ctx), ctx.server),
  },
];

/** Closing guidance after `me opencode init`. */
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

function createOpenCodeInitCommand(): Command {
  return buildInitCommand({
    description:
      "set up this project's OpenCode memory integration (acts as the project's .me agent)",
    steps: INIT_STEPS,
    outro: printInitOutro,
    // Project-scope only: no --scope. Fail fast without a `.me` agent, then
    // resolve the project root once for the steps.
    resolveContext: async (base) => {
      requireProjectAgent();
      return {
        ...base,
        scope: "project",
        projectRoot: await resolveProjectRoot(),
      };
    },
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
