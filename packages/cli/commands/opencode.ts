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
import {
  DEFAULT_PRIVATE_TREE_ROOT,
  importTranscriptSession,
} from "../importers/index.ts";
import { parseSessionById } from "../importers/opencode.ts";
import { type CaptureSurface, resolveCaptureProfile } from "../local-config.ts";
import {
  HOOK_EVENT_NAMES,
  type HookEventName,
  SESSIONS_NODE,
} from "../opencode/capture.ts";
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
        _cmd: Command,
      ) => {
        const eventName = opts.event as HookEventName;
        if (!HOOK_EVENT_NAMES.includes(eventName)) {
          console.error(
            `[memory-engine] unknown event '${opts.event}'. Expected one of: ${HOOK_EVENT_NAMES.join(", ")}`,
          );
          process.exit(0);
        }

        let policy: CaptureSurface | undefined;
        try {
          policy = resolveCaptureProfile(
            opts.projectDir ?? process.env.ME_PROJECT_DIR ?? process.cwd(),
          ).value;
        } catch (error) {
          console.error(
            `[memory-engine] ${eventName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(0);
        }
        if (!policy?.enabled || policy.harnesses.opencode !== true)
          process.exit(0);
        const { server, space } = policy;
        if (!server || !space) process.exit(0);

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
          const creds = resolveCredentials(server);
          if (!creds.apiKey && !creds.loggedIn) process.exit(0);
          const client = createMemoryClient({
            url: server,
            ...memoryBearer(server, creds.apiKey),
            space,
          });
          await importTranscriptSession(client, session, {
            treeRoot: policy.tree_root ?? DEFAULT_PRIVATE_TREE_ROOT,
            tree: policy.tree,
            sessionsNodeName: SESSIONS_NODE,
            fullTranscript: opts.fullTranscript ?? false,
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
