/**
 * me opencode — OpenCode integration commands.
 *
 * - me opencode install: install the dormant global OpenCode integration
 *   (also offered from `me project init`'s preflight — see
 *   `openCodeSetupAvailable`/`runOpenCodeInstallFlow`)
 * - me opencode hook:    invoked by the OpenCode plugin to capture a session
 * - me opencode import:  bulk-import OpenCode session history
 *
 * Per-project setup (session backfill, git history, memory pointers) is
 * `me project init` — harness-agnostic, not duplicated here. `me opencode
 * init` used to cover that; it's now a deprecated alias (wired in index.ts).
 */
import { Command } from "commander";
import type { StepAvailability } from "../agent/init.ts";
import { createMemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { installHarness, isHarnessInstalled } from "../harness/registry.ts";
import { importTranscriptSession } from "../importers/index.ts";
import { parseSessionById } from "../importers/opencode.ts";
import {
  HOOK_EVENT_NAMES,
  type HookEventName,
  resolveHookConfig,
  SESSIONS_NODE,
} from "../opencode/capture.ts";
import {
  discoverProjectConfig,
  setConfigDirOverride,
} from "../project-config.ts";
import { memoryBearer } from "../session.ts";
import { createOpenCodeImportCommand } from "./import.ts";
import {
  createHarnessInstallCommand,
  createHarnessUninstallCommand,
} from "./install.ts";

/**
 * Legacy `me project init` preflight adapter. Public install commands use the
 * same inventory-backed provider registry directly.
 */
export async function runOpenCodeInstallFlow(
  _opts: unknown,
  _globalOpts: Record<string, unknown>,
): Promise<void> {
  await installHarness("opencode");
}

/**
 * Whether `me project init`'s preflight should offer to run
 * {@link runOpenCodeInstallFlow}: hidden if OpenCode isn't installed on this
 * machine at all, "done" when the registry has recorded its integration.
 */
export async function openCodeSetupAvailable(): Promise<StepAvailability> {
  if (Bun.which("opencode") === null) return "hidden";
  return isHarnessInstalled("opencode") ? "done" : "available";
}

function createOpenCodeInstallCommand(): Command {
  return createHarnessInstallCommand("opencode");
}

/**
 * me opencode hook — invoked by the OpenCode plugin on session.idle /
 * session.deleted to capture the session.
 *
 * The plugin runs in-process JS and forwards the session id (not a transcript
 * path), so this command resolves the id from OpenCode's SQLite DB or legacy
 * storage and runs it through the same incremental write path as
 * `me import opencode`.
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
      "OpenCode data dir, SQLite DB, or legacy storage dir (default: standard location)",
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

        // Resolve the session id from SQLite when available, falling back to
        // the legacy JSON storage tree.
        let session: Awaited<ReturnType<typeof parseSessionById>>;
        try {
          session = await parseSessionById(opts.session, opts.storage);
        } catch (error) {
          console.error(
            `[memory-engine] ${eventName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(0);
        }
        if (!session) {
          console.error(
            `[memory-engine] ${eventName}: session '${opts.session}' not found in OpenCode data`,
          );
          process.exit(0);
        }

        // Import the session (incremental; same path as `me import opencode`).
        try {
          const client = createMemoryClient({
            url: config.server,
            ...memoryBearer(config.server, config.apiKey),
            space: config.space,
          });
          await importTranscriptSession(client, session, {
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
  opencode.addCommand(createHarnessUninstallCommand("opencode"));
  opencode.addCommand(createOpenCodeHookCommand());
  opencode.addCommand(createOpenCodeImportCommand());
  return opencode;
}
