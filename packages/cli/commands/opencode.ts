/**
 * me opencode — OpenCode integration commands.
 *
 * - me opencode install: register me as an MCP server with OpenCode, and
 *   install the capture plugin + /memory-recall command + memory-engine
 *   skill (also offered from `me project init`'s preflight — see
 *   `openCodeSetupAvailable`/`runOpenCodeInstallFlow`)
 * - me opencode hook:    invoked by the OpenCode plugin to capture a session
 * - me opencode import:  bulk-import OpenCode session history
 *
 * Per-project setup (session backfill, git history, memory pointers) is
 * `me project init` — harness-agnostic, not duplicated here. `me opencode
 * init` used to cover that; it's now a deprecated alias (wired in index.ts).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { ensureDefaultAgent } from "../agent/default-agent.ts";
import type { StepAvailability } from "../agent/init.ts";
import { createMemoryClient } from "../client.ts";
import { resolveCredentials, resolveHarnessAgent } from "../credentials.ts";
import { importTranscriptFile } from "../importers/index.ts";
import { opencodeImporter, resolveSessionFile } from "../importers/opencode.ts";
import { SlugRegistry } from "../importers/slug.ts";
import {
  type AgentInstallOptions,
  runAgentMcpInstall,
} from "../mcp/agent-install.ts";
import {
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
import { createOpenCodeImportCommand } from "./import.ts";

/** Absolute path of the generated capture plugin for a scope. */
function openCodePluginPath(scope: OpenCodeScope, projectRoot: string): string {
  return join(openCodePluginsDir(scope, projectRoot), PLUGIN_FILENAME);
}

/** Whether our managed capture plugin is already installed (by its marker). */
export async function openCodePluginInstalled(
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
 * plugin + `/memory-recall` command + `memory-engine` skill, and run the
 * shared capture opt-in — mirroring `me claude install`'s one-install model.
 * A headless (api-key) install stops after the MCP registration: capture is
 * credential-agnostic, so a headless deployment opts in via a committed
 * `.me` `capture: true` or the target machine's config.
 *
 * Exported so `me project init`'s preflight can offer this same flow — see
 * `openCodeSetupAvailable()` below.
 */
export async function runOpenCodeInstallFlow(
  opts: AgentInstallOptions & {
    scope?: OpenCodeScope;
    defaultAgent?: boolean;
    /** Set when called from `me project init`'s preflight — see
     * {@link ensureDefaultAgent}'s matching option. */
    perProjectStepFollows?: boolean;
  },
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const scope = opts.scope ?? "user";
  const projectRoot =
    scope === "project" ? await resolveProjectRoot() : process.cwd();
  await runAgentMcpInstall("opencode", {
    apiKey: opts.apiKey,
    server: opts.server,
    space: opts.space,
    scope,
    projectDir: scope === "project" ? projectRoot : undefined,
  });

  const creds = resolveCredentials(opts.server);
  const headless = Boolean(opts.apiKey ?? creds.apiKey);
  if (headless) return;

  const activeSpace = opts.space ?? creds.activeSpace;
  if (opts.defaultAgent !== false) {
    await ensureDefaultAgent(
      { ...creds, activeSpace },
      { perProjectStepFollows: opts.perProjectStepFollows },
    );
  }

  // The capture plugin — inert until capture is enabled (the flag below, or
  // a project's `.me` `capture: true`) — alongside the /memory-recall
  // command and the memory-engine skill, all at the same scope as the MCP
  // registration above.
  await installOpenCodePlugin(scope, projectRoot);
  await installRecallCommand(scope, projectRoot);
  await installSkill(scope, projectRoot);

  // Capture opt-in (shared with `me claude install`): prompt, persist
  // the machine-wide flag, and backfill existing sessions on yes.
  await runCapturePrompt(opencodeImporter, globalOpts, {
    space: activeSpace,
    toolLabel: "OpenCode",
    installCmd: "me opencode install",
  });
}

/**
 * Whether `me project init`'s preflight should offer to run
 * {@link runOpenCodeInstallFlow}: hidden if OpenCode isn't installed on this
 * machine at all, "done" if the user-scope capture plugin is already
 * present (mirrors `pluginInstallAvailable()` in claude.ts).
 */
export async function openCodeSetupAvailable(): Promise<StepAvailability> {
  if (Bun.which("opencode") === null) return "hidden";
  return (await openCodePluginInstalled("user", process.cwd()))
    ? "done"
    : "available";
}

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
        await runOpenCodeInstallFlow(
          { ...opts, server: globalOpts.server ?? opts.server },
          globalOpts,
        );
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
          // distinct from the "no credentials" error below. Checked BEFORE
          // resolving the agent below, so a project with capture off but no
          // agent configured stays silent rather than logging a resolution
          // error it doesn't need.
          if (!creds.captureEnabled) process.exit(0);
          // Capture is a harness surface like MCP, so it resolves the agent
          // ambiently (project agent: → global agent:) rather than the
          // explicit-only `creds.asAgent` — an unresolvable agent throws
          // here, into the catch below (capture skips), instead of silently
          // writing as the human.
          config = resolveHookConfig(
            { ...creds, asAgent: resolveHarnessAgent() },
            { fullTranscript: opts.fullTranscript },
          );
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

export function createOpenCodeCommand(): Command {
  const opencode = new Command("opencode").description("OpenCode integration");
  opencode.addCommand(createOpenCodeInstallCommand());
  opencode.addCommand(createOpenCodeHookCommand());
  opencode.addCommand(createOpenCodeImportCommand());
  return opencode;
}
