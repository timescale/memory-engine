/**
 * me gemini — Gemini CLI integration commands.
 *
 * Direct-write, scope-split (HARNESS_INTEGRATION_DESIGN.md §3.4):
 *   - `me gemini install`: USER scope (`~/.gemini/`, `~/.agents/skills/`) — acts
 *     as the human. MCP (`mcpServers.me`) + capture hooks in settings.json, the
 *     memory-engine skill in `~/.agents/skills/`, the /memory-recall TOML
 *     command, and a user memory pointer in `~/.gemini/GEMINI.md`. Optional
 *     `--server`/`--space` pins.
 *   - `me gemini init`: PROJECT scope (`.gemini/`, `.agents/skills/`, repo
 *     `GEMINI.md`) — acts as the project's `.me` agent: `--as-agent .me` in the
 *     MCP command + hooks, `ME_AS_AGENT=.me` in `.gemini/.env` (Tier-2), the git
 *     post-commit hook, and backfills. Requires a `.me/config.yaml` `agent:`.
 *   - `me gemini hook`: invoked by the settings hooks (reads event from stdin).
 *   - `me gemini import`: bulk-import Gemini CLI session history.
 *
 * MCP is written as JSON (not `gemini mcp add`) so a leading `--as-agent` arg
 * can't be misparsed and no binary is required. Gemini reads GEMINI.md (a repo
 * can also add AGENTS.md via `context.fileName`); we write GEMINI.md.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ASSET_MARKER,
  type AssetRenderOptions,
  projectSnippetMarkers,
  renderGeminiRecallCommand,
  renderProjectContextSnippet,
  renderSkill,
  renderUserContextSnippet,
  SKILL_FILENAME,
  SKILL_NAME,
  sharedSkillsDir,
  userSnippetMarkers,
} from "../agent/assets.ts";
import { parseHookScope, runCaptureHook } from "../agent/capture.ts";
import {
  buildInitCommand,
  type InitStep,
  type InitStepContext,
  initOutroLead,
  requireProjectAgent,
  type StepAvailability,
} from "../agent/init.ts";
import {
  hashMarkers,
  managedFileInstalled,
  readJsonFile,
  removeBlockFromFile,
  removeManagedFile,
  renderBlock,
  type UpsertOutcome,
  updateJsonFile,
  upsertBlockInFile,
  writeManagedFile,
} from "../agent/managed.ts";
import { resolveCredentials } from "../credentials.ts";
import {
  geminiHooksHasCapture,
  removeGeminiHooks,
  removeGeminiMcp,
  upsertGeminiHooks,
  upsertGeminiMcp,
} from "../gemini/settings.ts";
import { geminiImporter } from "../importers/gemini.ts";
import { DEFAULT_TREE_ROOT } from "../importers/index.ts";
import { SlugRegistry } from "../importers/slug.ts";
import { buildMeCommand } from "../mcp/install.ts";
import { createGeminiImportCommand, runAgentImport } from "./import.ts";
import { runGitImport } from "./import-git.ts";
import { gitHookStatus, runGitHookInstall } from "./import-git-hook.ts";

type Scope = "user" | "project";

// =============================================================================
// Scoped asset paths
// =============================================================================

const geminiDir = (scope: Scope, root: string): string =>
  scope === "project" ? join(root, ".gemini") : join(homedir(), ".gemini");
const settingsFile = (scope: Scope, root: string): string =>
  join(geminiDir(scope, root), "settings.json");
const commandFile = (scope: Scope, root: string): string =>
  join(geminiDir(scope, root), "commands", "memory-recall.toml");
const envFile = (scope: Scope, root: string): string =>
  join(geminiDir(scope, root), ".env");
const skillFile = (scope: Scope, root: string): string =>
  join(sharedSkillsDir(scope, root), SKILL_NAME, SKILL_FILENAME);
/** Context file: repo GEMINI.md (project) vs ~/.gemini/GEMINI.md (user). */
const contextFile = (scope: Scope, root: string): string =>
  scope === "project"
    ? join(root, "GEMINI.md")
    : join(geminiDir("user", root), "GEMINI.md");

const ENV_MARKERS = hashMarkers("me init");

function verb(o: UpsertOutcome): string {
  return o === "installed"
    ? "Installed"
    : o === "updated"
      ? "Updated"
      : "Already up to date:";
}

const renderOpts = (scope: Scope): AssetRenderOptions => ({
  agentMode: scope === "project",
});

// =============================================================================
// Scoped asset installers
// =============================================================================

async function installMcpAndHooks(
  scope: Scope,
  root: string,
  pins: { server?: string; space?: string } = {},
): Promise<void> {
  const meCmd = buildMeCommand({
    asAgent: scope === "project" ? ".me" : undefined,
    server: pins.server,
    space: pins.space,
  });
  const file = settingsFile(scope, root);
  await updateJsonFile(file, (s) =>
    upsertGeminiHooks(upsertGeminiMcp(s, meCmd), { scope }),
  );
  clack.log.success(`Registered MCP server + capture hooks → ${file}`);
}

async function installSkill(scope: Scope, root: string): Promise<void> {
  const file = skillFile(scope, root);
  const outcome = await writeManagedFile(
    file,
    renderSkill(renderOpts(scope)),
    ASSET_MARKER,
  );
  clack.log.success(`${verb(outcome)} the ${SKILL_NAME} skill → ${file}`);
}

async function installRecall(scope: Scope, root: string): Promise<void> {
  const file = commandFile(scope, root);
  const outcome = await writeManagedFile(
    file,
    renderGeminiRecallCommand(),
    ASSET_MARKER,
  );
  clack.log.success(`${verb(outcome)} the /memory-recall command → ${file}`);
}

/** Tier-2: inject ME_AS_AGENT=.me into Gemini's tool shells via `.gemini/.env`
 * (never excluded from env loading). Project scope only. */
async function installEnv(root: string): Promise<void> {
  const file = envFile("project", root);
  const outcome = await upsertBlockInFile(
    file,
    renderBlock(ENV_MARKERS, ["ME_AS_AGENT=.me"]),
    ENV_MARKERS,
  );
  clack.log.success(`${verb(outcome)} the agent-mode env → ${file}`);
}

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
  scope: Scope,
  root: string,
  server?: string,
): Promise<void> {
  const file = contextFile(scope, root);
  const [block, markers] =
    scope === "user"
      ? ([renderUserContextSnippet(), userSnippetMarkers()] as const)
      : ([
          renderProjectContextSnippet(await projectFacts(root, server)),
          projectSnippetMarkers(),
        ] as const);
  const outcome = await upsertBlockInFile(file, block, markers);
  clack.log.success(`${verb(outcome)} the memory pointer → ${file}`);
}

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

async function geminiProjectCaptureInstalled(root: string): Promise<boolean> {
  try {
    const settings = await readJsonFile(settingsFile("project", root));
    return settings !== null && geminiHooksHasCapture(settings);
  } catch {
    return false;
  }
}

// =============================================================================
// me gemini install (USER scope)
// =============================================================================

function createGeminiInstallCommand(): Command {
  return new Command("install")
    .description(
      "set up the Gemini CLI integration for your user (MCP + capture + skill + command)",
    )
    .option("--server <url>", "pin a server for the MCP config")
    .option(
      "--space <slug>",
      "pin a space for the MCP config (implies --server)",
    )
    .option("--remove", "remove the user-scope Gemini integration")
    .action(
      async (
        opts: { server?: string; space?: string; remove?: boolean },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        const server = globalOpts.server ?? opts.server ?? undefined;
        const scope: Scope = "user";
        const root = process.cwd(); // user scope ignores it (uniform API)

        if (opts.remove) {
          await updateJsonFile(settingsFile(scope, root), (s) =>
            removeGeminiHooks(removeGeminiMcp(s)),
          ).catch(() => {});
          await removeManagedFile(skillFile(scope, root), ASSET_MARKER);
          await removeManagedFile(commandFile(scope, root), ASSET_MARKER);
          await removeBlockFromFile(
            contextFile(scope, root),
            userSnippetMarkers(),
          );
          clack.log.success("Removed the user-scope Gemini integration.");
          return;
        }

        const creds = resolveCredentials(server);
        if (!creds.apiKey && !creds.loggedIn) {
          clack.log.error(
            "Not logged in. Run 'me login' first (or set ME_API_KEY for a headless install).",
          );
          process.exit(1);
        }
        let pins: { server?: string; space?: string } = {};
        if (opts.server || opts.space) {
          pins = opts.space
            ? { server: opts.server ?? creds.server, space: opts.space }
            : { server: opts.server };
        }

        await installMcpAndHooks(scope, root, pins);
        await installSkill(scope, root);
        await installRecall(scope, root);
        await installContextSnippet(scope, root, server);
        clack.log.success(
          "Gemini is set up for your user. New sessions are captured to Memory Engine.",
        );
      },
    );
}

// =============================================================================
// me gemini hook (capture) — reads the event JSON from stdin
// =============================================================================

interface HookEvent {
  transcript_path?: string;
  cwd?: string;
}

function createGeminiHookCommand(): Command {
  return new Command("hook")
    .description("invoked by Gemini CLI capture hooks (reads event from stdin)")
    .requiredOption(
      "--event <name>",
      "hook event name (after-agent, session-end)",
    )
    .option(
      "--scope <scope>",
      "install scope that authored this hook (user|project)",
    )
    .option(
      "--full-transcript",
      "also store reasoning + tool calls/results (default: prompts + responses)",
    )
    .action(
      async (opts: {
        event: string;
        scope?: string;
        fullTranscript?: boolean;
      }) => {
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
            `[memory-engine] ${opts.event}: no transcript_path in event payload`,
          );
          process.exit(0);
        }

        await runCaptureHook({
          harness: "gemini",
          event: opts.event,
          scope: parseHookScope(opts.scope),
          transcriptPath,
          projectCwd: event.cwd ?? process.cwd(),
          importer: geminiImporter,
          projectCaptureInstalled: geminiProjectCaptureInstalled,
          input: { fullTranscript: opts.fullTranscript },
        });
        process.exit(0);
      },
    );
}

// =============================================================================
// me gemini init (PROJECT scope)
// =============================================================================

async function resolveProjectRoot(): Promise<string> {
  const { gitRoot } = await new SlugRegistry().resolve(process.cwd());
  return gitRoot ?? process.cwd();
}

const projectRootOf = (ctx: InitStepContext): string =>
  ctx.projectRoot ?? process.cwd();

const INIT_STEPS: InitStep[] = [
  {
    id: "session-import",
    group: "Gemini sessions",
    kind: "backfill",
    optionKey: "skipSessionImport",
    skipFlag: "--skip-session-import",
    skipDescription: "do not import this project's Gemini sessions",
    label: "Import this project's existing Gemini sessions (one-time backfill)",
    run: async (ctx) => {
      await runAgentImport(
        geminiImporter,
        { project: projectRootOf(ctx), includeTempCwd: true },
        ctx.globalOpts,
      );
    },
  },
  {
    id: "mcp-hooks-install",
    group: "Gemini sessions",
    kind: "ongoing",
    optionKey: "skipMcpInstall",
    skipFlag: "--skip-mcp-install",
    skipDescription: "do not register the MCP server + capture hooks",
    label:
      "Register the MCP server + capture hooks — memory tools + capture new sessions",
    available: async (ctx) =>
      (await geminiProjectCaptureInstalled(projectRootOf(ctx)))
        ? "done"
        : "available",
    doneLabel: "Gemini MCP server + capture hooks already installed",
    rerunLabel: "Reinstall the MCP server + capture hooks (already installed)",
    run: (ctx) => installMcpAndHooks("project", projectRootOf(ctx)),
  },
  {
    id: "env-install",
    group: "Gemini sessions",
    kind: "config",
    optionKey: "skipEnv",
    skipFlag: "--skip-env",
    skipDescription: "do not write ME_AS_AGENT into .gemini/.env",
    label:
      "Inject ME_AS_AGENT=.me into .gemini/.env (ad-hoc `me` runs as the agent)",
    run: (ctx) => installEnv(projectRootOf(ctx)),
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
        commandFile("project", projectRootOf(ctx)),
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
    run: ({ globalOpts }) =>
      runGitHookInstall({ skipIfNotRepo: true, asAgent: ".me" }, globalOpts),
  },
  {
    id: "gemini-md",
    group: "Project config",
    kind: "config",
    optionKey: "skipGeminiMd",
    skipFlag: "--skip-gemini-md",
    skipDescription:
      "do not write the memory pointer into the project's GEMINI.md",
    label: "Add a memory pointer to GEMINI.md",
    available: async ({ server }) =>
      (await contextSnippetUpToDate(await resolveProjectRoot(), server))
        ? "done"
        : ("available" satisfies StepAvailability),
    doneLabel: "Memory pointer already in GEMINI.md",
    rerunLabel: "Rewrite the memory pointer in GEMINI.md (already present)",
    run: (ctx) =>
      installContextSnippet("project", projectRootOf(ctx), ctx.server),
  },
];

function printInitOutro(steps: InitStep[]): void {
  clack.note(
    [
      ...initOutroLead(steps),
      "Ask Gemini about this project's history or architecture — it now draws",
      "on the project's memories through the `me_memory_search` tool.",
    ].join("\n"),
    "Your project now has memory",
  );
}

function createGeminiInitCommand(): Command {
  return buildInitCommand({
    description:
      "set up this project's Gemini memory integration (acts as the project's .me agent)",
    steps: INIT_STEPS,
    outro: printInitOutro,
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

export function createGeminiCommand(): Command {
  const gemini = new Command("gemini").description("Gemini CLI integration");
  gemini.addCommand(createGeminiInstallCommand());
  gemini.addCommand(createGeminiInitCommand());
  gemini.addCommand(createGeminiHookCommand());
  gemini.addCommand(createGeminiImportCommand());
  return gemini;
}
