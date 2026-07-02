/**
 * me claude — Claude Code integration commands.
 *
 * Direct-write integration (no marketplace plugin — see
 * HARNESS_INTEGRATION_DESIGN.md §6). Two scopes, two commands:
 *   - `me claude install`: USER scope (`~/.claude/`) — acts as the human. MCP
 *     (`claude mcp add --scope user`), capture hooks in `~/.claude/settings.json`,
 *     the memory-engine skill, the /memory-recall command, and a user memory
 *     pointer in `~/.claude/CLAUDE.md`. Optional `--server`/`--space` pins.
 *   - `me claude init`: PROJECT scope (`.claude/` + repo `.mcp.json` / CLAUDE.md)
 *     — acts as the project's `.me` agent. Everything install does plus
 *     `--as-agent .me` on the MCP + hook commands, `env.ME_AS_AGENT=.me` in
 *     `.claude/settings.json`, the git post-commit hook, and one-time backfills.
 *     Requires a `.me/config.yaml` with an `agent:` (fail-fast).
 *   - `me claude hook`: invoked by the settings hooks (reads event from stdin).
 *   - `me claude import`: bulk-import Claude Code session history.
 *
 * Claude reads CLAUDE.md, not AGENTS.md — so the project pointer goes in
 * CLAUDE.md, using an `@AGENTS.md` import when a shared AGENTS.md block already
 * exists (written by another harness's init).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ASSET_MARKER,
  type AssetRenderOptions,
  projectSnippetMarkers,
  RECALL_COMMAND_FILENAME,
  renderClaudeImportSnippet,
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
  readJsonFile,
  removeBlockFromFile,
  removeManagedFile,
  type UpsertOutcome,
  updateJsonFile,
  upsertBlockInFile,
  writeManagedFile,
} from "../agent/managed.ts";
import {
  claudeSettingsHasCapture,
  removeClaudeSettings,
  upsertClaudeSettings,
} from "../claude/settings.ts";
import { resolveCredentials } from "../credentials.ts";
import { claudeImporter } from "../importers/claude.ts";
import { DEFAULT_TREE_ROOT } from "../importers/index.ts";
import { SlugRegistry } from "../importers/slug.ts";
import {
  buildMeCommand,
  installMcpServer,
  MCP_TOOLS,
  type McpToolCli,
} from "../mcp/install.ts";
import { createClaudeImportCommand, runAgentImport } from "./import.ts";
import { runGitImport } from "./import-git.ts";
import { gitHookStatus, runGitHookInstall } from "./import-git-hook.ts";

export { initOutroLead };

/** Claude Code capture events (Stop = per-turn, SessionEnd = final flush). */
const HOOK_EVENT_NAMES = ["stop", "session-end"] as const;
type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** The slice of a Claude hook event payload we read from stdin. */
interface HookEvent {
  transcript_path?: string;
  cwd?: string;
}

type Scope = "user" | "project";

// =============================================================================
// Scoped asset paths
// =============================================================================

const USER_CLAUDE_DIR = join(homedir(), ".claude");
const claudeBase = (scope: Scope, root: string): string =>
  scope === "project" ? join(root, ".claude") : USER_CLAUDE_DIR;
const settingsFile = (scope: Scope, root: string): string =>
  join(claudeBase(scope, root), "settings.json");
const skillFile = (scope: Scope, root: string): string =>
  join(claudeBase(scope, root), "skills", SKILL_NAME, SKILL_FILENAME);
const recallFile = (scope: Scope, root: string): string =>
  join(claudeBase(scope, root), "commands", RECALL_COMMAND_FILENAME);
/** Context file: repo CLAUDE.md (project) vs ~/.claude/CLAUDE.md (user). */
const contextFile = (scope: Scope, root: string): string =>
  scope === "project"
    ? join(root, "CLAUDE.md")
    : join(USER_CLAUDE_DIR, "CLAUDE.md");

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

const claudeTool = (): McpToolCli => {
  const tool = MCP_TOOLS.find((t) => t.bin === "claude");
  if (!tool || tool.method !== "cli") throw new Error("claude tool missing");
  return tool;
};

// =============================================================================
// Scoped asset installers (shared by install + init)
// =============================================================================

async function installMcp(
  scope: Scope,
  pins: { server?: string; space?: string } = {},
): Promise<void> {
  const meCmd = buildMeCommand({
    asAgent: scope === "project" ? ".me" : undefined,
    server: pins.server,
    space: pins.space,
  });
  const result = await installMcpServer(claudeTool(), meCmd, { scope });
  if (result.success) clack.log.success(result.message);
  else {
    clack.log.error(result.message);
    process.exit(1);
  }
}

async function removeMcp(scope: Scope): Promise<void> {
  const proc = Bun.spawn(claudeTool().removeCmd({ scope }), {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

async function installHooks(scope: Scope, root: string): Promise<void> {
  const file = settingsFile(scope, root);
  await updateJsonFile(file, (s) => upsertClaudeSettings(s, { scope }));
  clack.log.success(`Registered capture hooks → ${file}`);
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
  const file = recallFile(scope, root);
  const outcome = await writeManagedFile(
    file,
    renderRecallCommand(),
    ASSET_MARKER,
  );
  clack.log.success(`${verb(outcome)} the /memory-recall command → ${file}`);
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

/** Whether the repo already carries the shared AGENTS.md project block (from
 * another harness's init) — if so Claude imports it via `@AGENTS.md`. */
async function repoHasSharedBlock(root: string): Promise<boolean> {
  try {
    return (await Bun.file(join(root, "AGENTS.md")).text()).includes(
      projectSnippetMarkers().start,
    );
  } catch {
    return false;
  }
}

/** The CLAUDE.md block to write at project scope: the `@AGENTS.md` bridge when
 * a shared block exists, else the full templated snippet. */
async function projectClaudeBlock(
  root: string,
  server?: string,
): Promise<string> {
  return (await repoHasSharedBlock(root))
    ? renderClaudeImportSnippet()
    : renderProjectContextSnippet(await projectFacts(root, server));
}

async function installContextSnippet(
  scope: Scope,
  root: string,
  server?: string,
): Promise<void> {
  const file = contextFile(scope, root);
  const block =
    scope === "user"
      ? renderUserContextSnippet()
      : await projectClaudeBlock(root, server);
  const markers =
    scope === "user" ? userSnippetMarkers() : projectSnippetMarkers();
  const outcome = await upsertBlockInFile(file, block, markers);
  clack.log.success(`${verb(outcome)} the memory pointer → ${file}`);
}

async function contextSnippetUpToDate(
  root: string,
  server?: string,
): Promise<boolean> {
  const block = await projectClaudeBlock(root, server);
  try {
    return (await Bun.file(contextFile("project", root)).text()).includes(
      block,
    );
  } catch {
    return false;
  }
}

/** Whether Claude project-scope capture is installed at `root` (the dedup gate
 * for user-scope hook invocations). */
async function claudeProjectCaptureInstalled(root: string): Promise<boolean> {
  try {
    const settings = await readJsonFile(settingsFile("project", root));
    return settings !== null && claudeSettingsHasCapture(settings);
  } catch {
    return false;
  }
}

function requireClaudeBinary(): void {
  if (Bun.which("claude") === null) {
    clack.log.error(
      "Claude Code (claude) not found on PATH. Install it first.",
    );
    process.exit(1);
  }
}

// =============================================================================
// me claude install (USER scope)
// =============================================================================

function createClaudeInstallCommand(): Command {
  return new Command("install")
    .description(
      "set up the Claude Code integration for your user (MCP + capture + skill + command)",
    )
    .option(
      "--server <url>",
      "pin a server for the MCP config (implies your login session for it)",
    )
    .option(
      "--space <slug>",
      "pin a space for the MCP config (implies --server)",
    )
    .option("--remove", "remove the user-scope Claude Code integration")
    .action(
      async (
        opts: { server?: string; space?: string; remove?: boolean },
        cmd: Command,
      ) => {
        const globalOpts = cmd.optsWithGlobals();
        const server = globalOpts.server ?? opts.server ?? undefined;
        const scope: Scope = "user";
        const root = process.cwd(); // user scope ignores it (uniform API)
        requireClaudeBinary();

        if (opts.remove) {
          await removeMcp(scope);
          await updateJsonFile(settingsFile(scope, root), (s) =>
            removeClaudeSettings(s),
          ).catch(() => {});
          await removeManagedFile(skillFile(scope, root), ASSET_MARKER);
          await removeManagedFile(recallFile(scope, root), ASSET_MARKER);
          await removeBlockFromFile(
            contextFile(scope, root),
            userSnippetMarkers(),
          );
          clack.log.success("Removed the user-scope Claude Code integration.");
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

        await installMcp(scope, pins);
        await installHooks(scope, root);
        await installSkill(scope, root);
        await installRecall(scope, root);
        await installContextSnippet(scope, root, server);
        clack.log.success(
          "Claude Code is set up for your user. New sessions are captured to Memory Engine.",
        );
      },
    );
}

// =============================================================================
// me claude hook (capture) — reads the event JSON from stdin
// =============================================================================

function createClaudeHookCommand(): Command {
  return new Command("hook")
    .description(
      "invoked by Claude Code capture hooks (reads event from stdin)",
    )
    .requiredOption(
      "--event <name>",
      `hook event name (${HOOK_EVENT_NAMES.join(", ")})`,
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
        const eventName = opts.event as HookEventName;
        if (!HOOK_EVENT_NAMES.includes(eventName)) {
          console.error(
            `[memory-engine] unknown event '${opts.event}'. Expected one of: ${HOOK_EVENT_NAMES.join(", ")}`,
          );
          process.exit(0);
        }

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

        await runCaptureHook({
          harness: "claude",
          event: eventName,
          scope: parseHookScope(opts.scope),
          transcriptPath,
          projectCwd: event.cwd ?? process.cwd(),
          importer: claudeImporter,
          projectCaptureInstalled: claudeProjectCaptureInstalled,
          input: { fullTranscript: opts.fullTranscript },
        });
        process.exit(0);
      },
    );
}

// =============================================================================
// me claude init (PROJECT scope)
// =============================================================================

/** Project root anchor (git root, else cwd). `claude mcp add --scope project`
 * writes `.mcp.json` relative to the process cwd, so run init from the repo. */
async function resolveProjectRoot(): Promise<string> {
  const { gitRoot } = await new SlugRegistry().resolve(process.cwd());
  return gitRoot ?? process.cwd();
}

const projectRootOf = (ctx: InitStepContext): string =>
  ctx.projectRoot ?? process.cwd();

const INIT_STEPS: InitStep[] = [
  {
    id: "transcript-import",
    group: "Claude Code sessions",
    kind: "backfill",
    optionKey: "skipTranscriptImport",
    skipFlag: "--skip-transcript-import",
    skipDescription: "do not import this project's Claude Code sessions",
    label:
      "Import this project's existing Claude Code sessions (one-time backfill)",
    run: async (ctx) => {
      await runAgentImport(
        claudeImporter,
        { project: projectRootOf(ctx), includeTempCwd: true },
        ctx.globalOpts,
      );
    },
  },
  {
    id: "hooks-install",
    group: "Claude Code sessions",
    kind: "ongoing",
    optionKey: "skipHooksInstall",
    skipFlag: "--skip-hooks-install",
    skipDescription: "do not install the Claude Code capture hooks",
    label:
      "Install the Claude Code capture hooks — captures new sessions going forward",
    available: async (ctx) =>
      (await claudeProjectCaptureInstalled(projectRootOf(ctx)))
        ? "done"
        : "available",
    doneLabel: "Claude Code capture hooks already installed",
    rerunLabel:
      "Reinstall the Claude Code capture hooks — captures new sessions going forward (already installed)",
    run: (ctx) => installHooks("project", projectRootOf(ctx)),
  },
  {
    id: "mcp-install",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipMcpInstall",
    skipFlag: "--skip-mcp-install",
    skipDescription: "do not register me as an MCP server with Claude Code",
    label:
      "Register me as an MCP server — gives Claude the memory search/create tools",
    run: () => installMcp("project"),
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
    run: ({ globalOpts }) =>
      runGitHookInstall({ skipIfNotRepo: true, asAgent: ".me" }, globalOpts),
  },
  {
    id: "claude-md",
    group: "Project config",
    kind: "config",
    optionKey: "skipClaudeMd",
    skipFlag: "--skip-claude-md",
    skipDescription:
      "do not write the memory pointer into the project's CLAUDE.md",
    label: "Add a memory pointer to CLAUDE.md",
    available: async ({ server }) =>
      (await contextSnippetUpToDate(await resolveProjectRoot(), server))
        ? "done"
        : ("available" satisfies StepAvailability),
    doneLabel: "Memory pointer already in CLAUDE.md",
    rerunLabel: "Rewrite the memory pointer in CLAUDE.md (already present)",
    run: (ctx) =>
      installContextSnippet("project", projectRootOf(ctx), ctx.server),
  },
];

function printInitOutro(steps: InitStep[]): void {
  clack.note(
    [
      ...initOutroLead(steps),
      "Ask Claude about this project's history or architecture — it now",
      "draws on the project's memories automatically, and consults them",
      "when exploring the code for new features.",
      "",
      "You can also point Claude at them explicitly, e.g.:",
      `${DIM}"Search memory engine: why did we structure the database this way?"${DIM_OFF}`,
      `${DIM}"Check me memories for past work on this area before we start"${DIM_OFF}`,
      `${DIM}"What do my me memories say about how deploys work here?"${DIM_OFF}`,
    ].join("\n"),
    "Your project now has memory",
  );
}

function createClaudeInitCommand(): Command {
  return buildInitCommand({
    description:
      "set up this project's Claude Code memory integration (acts as the project's .me agent)",
    steps: INIT_STEPS,
    outro: printInitOutro,
    resolveContext: async (base) => {
      requireProjectAgent();
      requireClaudeBinary();
      return {
        ...base,
        scope: "project",
        projectRoot: await resolveProjectRoot(),
      };
    },
  });
}

export function createClaudeCommand(): Command {
  const claude = new Command("claude").description("Claude Code integration");
  claude.addCommand(createClaudeInstallCommand());
  claude.addCommand(createClaudeInitCommand());
  claude.addCommand(createClaudeHookCommand());
  claude.addCommand(createClaudeImportCommand());
  return claude;
}
