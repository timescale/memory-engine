/**
 * me codex — Codex CLI integration commands.
 *
 * Direct-write, scope-split (design/HARNESS_INTEGRATION_DESIGN.md §3.3):
 *   - `me codex install`: USER scope (`~/.codex/`, `~/.agents/skills/`) — acts
 *     as the human. MCP + shell-env live in `config.toml` (a managed TOML
 *     block); capture hooks in `hooks.json`; the memory-engine + memory-recall
 *     skills in `~/.agents/skills/`; a user memory pointer in
 *     `~/.codex/AGENTS.md`. Optional `--server`/`--space` pins.
 *   - `me codex init`: PROJECT scope (`.codex/`, `.agents/skills/`, repo
 *     `AGENTS.md`) — acts as the project's `.me` agent: `--as-agent .me` in the
 *     MCP command, a `[shell_environment_policy]` injecting `ME_AS_AGENT=.me`,
 *     agent-mode capture hooks, the git post-commit hook, and backfills.
 *     Requires a `.me/config.yaml` with an `agent:` (fail-fast). Project
 *     `.codex/` is trust-gated — init prints a reminder.
 *   - `me codex hook`: invoked by the Stop hook (reads the event from stdin).
 *   - `me codex import`: bulk-import Codex session history.
 *
 * Codex custom prompts are deprecated + user-only, so /memory-recall ships as a
 * skill (not a command). Codex reads AGENTS.md natively (no CLAUDE.md bridge).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  ASSET_MARKER,
  type AssetRenderOptions,
  projectSnippetMarkers,
  RECALL_SKILL_NAME,
  renderProjectContextSnippet,
  renderRecallSkill,
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
  codexHooksHasCapture,
  codexTomlMarkers,
  removeCodexHooks,
  renderCodexTomlBlock,
  upsertCodexHooks,
} from "../codex/config.ts";
import { resolveCredentials } from "../credentials.ts";
import { codexImporter } from "../importers/codex.ts";
import { DEFAULT_TREE_ROOT } from "../importers/index.ts";
import { SlugRegistry } from "../importers/slug.ts";
import { buildMeCommand } from "../mcp/install.ts";
import { createCodexImportCommand, runAgentImport } from "./import.ts";
import { runGitImport } from "./import-git.ts";
import { gitHookStatus, runGitHookInstall } from "./import-git-hook.ts";

type Scope = "user" | "project";

// =============================================================================
// Scoped asset paths
// =============================================================================

const codexDir = (scope: Scope, root: string): string =>
  scope === "project" ? join(root, ".codex") : join(homedir(), ".codex");
const configToml = (scope: Scope, root: string): string =>
  join(codexDir(scope, root), "config.toml");
const hooksJson = (scope: Scope, root: string): string =>
  join(codexDir(scope, root), "hooks.json");
const skillDirFile = (scope: Scope, root: string, name: string): string =>
  join(sharedSkillsDir(scope, root), name, SKILL_FILENAME);
/** Context file: repo AGENTS.md (project) vs ~/.codex/AGENTS.md (user). */
const contextFile = (scope: Scope, root: string): string =>
  scope === "project"
    ? join(root, "AGENTS.md")
    : join(codexDir("user", root), "AGENTS.md");

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

async function installMcp(
  scope: Scope,
  root: string,
  pins: { server?: string; space?: string } = {},
): Promise<void> {
  const meCmd = buildMeCommand({
    asAgent: scope === "project" ? ".me" : undefined,
    server: pins.server,
    space: pins.space,
  });
  const file = configToml(scope, root);
  const outcome = await upsertBlockInFile(
    file,
    renderCodexTomlBlock(scope, meCmd),
    codexTomlMarkers(scope),
  );
  clack.log.success(`${verb(outcome)} the MCP server config → ${file}`);
}

async function installHooks(scope: Scope, root: string): Promise<void> {
  const file = hooksJson(scope, root);
  await updateJsonFile(file, (f) => upsertCodexHooks(f, { scope }));
  clack.log.success(`Registered capture hook → ${file}`);
}

async function installSkills(scope: Scope, root: string): Promise<void> {
  const skill = skillDirFile(scope, root, SKILL_NAME);
  const recall = skillDirFile(scope, root, RECALL_SKILL_NAME);
  const o1 = await writeManagedFile(
    skill,
    renderSkill(renderOpts(scope)),
    ASSET_MARKER,
  );
  clack.log.success(`${verb(o1)} the ${SKILL_NAME} skill → ${skill}`);
  const o2 = await writeManagedFile(recall, renderRecallSkill(), ASSET_MARKER);
  clack.log.success(`${verb(o2)} the ${RECALL_SKILL_NAME} skill → ${recall}`);
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

async function codexProjectCaptureInstalled(root: string): Promise<boolean> {
  try {
    const hooks = await readJsonFile(hooksJson("project", root));
    return hooks !== null && codexHooksHasCapture(hooks);
  } catch {
    return false;
  }
}

// =============================================================================
// me codex install (USER scope)
// =============================================================================

function createCodexInstallCommand(): Command {
  return new Command("install")
    .description(
      "set up the Codex CLI integration for your user (MCP + capture + skills)",
    )
    .option("--server <url>", "pin a server for the MCP config")
    .option(
      "--space <slug>",
      "pin a space for the MCP config (implies --server)",
    )
    .option("--remove", "remove the user-scope Codex integration")
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
          await removeBlockFromFile(
            configToml(scope, root),
            codexTomlMarkers(scope),
          );
          await updateJsonFile(hooksJson(scope, root), (f) =>
            removeCodexHooks(f),
          ).catch(() => {});
          await removeManagedFile(
            skillDirFile(scope, root, SKILL_NAME),
            ASSET_MARKER,
          );
          await removeManagedFile(
            skillDirFile(scope, root, RECALL_SKILL_NAME),
            ASSET_MARKER,
          );
          await removeBlockFromFile(
            contextFile(scope, root),
            userSnippetMarkers(),
          );
          clack.log.success("Removed the user-scope Codex integration.");
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

        await installMcp(scope, root, pins);
        await installHooks(scope, root);
        await installSkills(scope, root);
        await installContextSnippet(scope, root, server);
        clack.log.success(
          "Codex is set up for your user. New sessions are captured to Memory Engine.",
        );
      },
    );
}

// =============================================================================
// me codex hook (capture) — reads the event JSON from stdin
// =============================================================================

interface HookEvent {
  transcript_path?: string;
  cwd?: string;
}

function createCodexHookCommand(): Command {
  return new Command("hook")
    .description("invoked by the Codex Stop hook (reads event from stdin)")
    .requiredOption("--event <name>", "hook event name (stop)")
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
        // Codex only wires Stop; accept it (and tolerate others gracefully).
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
          harness: "codex",
          event: opts.event,
          scope: parseHookScope(opts.scope),
          transcriptPath,
          projectCwd: event.cwd ?? process.cwd(),
          importer: codexImporter,
          projectCaptureInstalled: codexProjectCaptureInstalled,
          input: { fullTranscript: opts.fullTranscript },
        });
        process.exit(0);
      },
    );
}

// =============================================================================
// me codex init (PROJECT scope)
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
    group: "Codex sessions",
    kind: "backfill",
    optionKey: "skipSessionImport",
    skipFlag: "--skip-session-import",
    skipDescription: "do not import this project's Codex sessions",
    label: "Import this project's existing Codex sessions (one-time backfill)",
    run: async (ctx) => {
      await runAgentImport(
        codexImporter,
        { project: projectRootOf(ctx), includeTempCwd: true },
        ctx.globalOpts,
      );
    },
  },
  {
    id: "hooks-install",
    group: "Codex sessions",
    kind: "ongoing",
    optionKey: "skipHooksInstall",
    skipFlag: "--skip-hooks-install",
    skipDescription: "do not install the Codex capture hook",
    label:
      "Install the Codex capture hook — captures new sessions going forward",
    available: async (ctx) =>
      (await codexProjectCaptureInstalled(projectRootOf(ctx)))
        ? "done"
        : "available",
    doneLabel: "Codex capture hook already installed",
    rerunLabel:
      "Reinstall the Codex capture hook — captures new sessions going forward (already installed)",
    run: (ctx) => installHooks("project", projectRootOf(ctx)),
  },
  {
    id: "mcp-install",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipMcpInstall",
    skipFlag: "--skip-mcp-install",
    skipDescription: "do not register me as an MCP server with Codex",
    label:
      "Register me as an MCP server — gives Codex the memory search/create tools",
    run: (ctx) => installMcp("project", projectRootOf(ctx)),
  },
  {
    id: "skills",
    group: "Memory tools",
    kind: "config",
    optionKey: "skipSkills",
    skipFlag: "--skip-skills",
    skipDescription: "do not install the memory-engine + memory-recall skills",
    label: "Install the memory-engine + memory-recall skills",
    available: async (ctx) =>
      (await managedFileInstalled(
        skillDirFile("project", projectRootOf(ctx), SKILL_NAME),
        ASSET_MARKER,
      ))
        ? "done"
        : "available",
    doneLabel: "memory-engine skill already installed",
    rerunLabel:
      "Rewrite the memory-engine + memory-recall skills (already installed)",
    run: (ctx) => installSkills("project", projectRootOf(ctx)),
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

function printInitOutro(steps: InitStep[]): void {
  clack.note(
    [
      ...initOutroLead(steps),
      "Note: Codex gates project `.codex/` config behind trusting the project,",
      "and a new capture hook needs a one-time approval (`/hooks`). Trust the",
      "project and approve the hook so captures run.",
      "",
      "Ask Codex about this project's history or architecture — it now draws on",
      "the project's memories through the `me_memory_search` tool.",
    ].join("\n"),
    "Your project now has memory",
  );
}

function createCodexInitCommand(): Command {
  return buildInitCommand({
    description:
      "set up this project's Codex memory integration (acts as the project's .me agent)",
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

export function createCodexCommand(): Command {
  const codex = new Command("codex").description("Codex CLI integration");
  codex.addCommand(createCodexInstallCommand());
  codex.addCommand(createCodexInitCommand());
  codex.addCommand(createCodexHookCommand());
  codex.addCommand(createCodexImportCommand());
  return codex;
}
