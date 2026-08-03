/** Claude Code integration commands and dormant hook entry points. */
import { Command } from "commander";
import type { StepAvailability } from "../agent/init.ts";
import {
  HOOK_EVENT_NAMES,
  type HookEvent,
  type HookEventName,
  SESSIONS_NODE,
} from "../claude/capture.ts";
import { createMemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { installHarness, isHarnessInstalled } from "../harness/registry.ts";
import { buildContractVars, upsertContractBlock } from "../harness-contract.ts";
import { claudeImporter } from "../importers/claude.ts";
import {
  DEFAULT_PRIVATE_TREE_ROOT,
  importTranscriptFile,
} from "../importers/index.ts";
import { type CaptureSurface, resolveCaptureProfile } from "../local-config.ts";
import { memoryBearer } from "../session.ts";
import { createClaudeImportCommand } from "./import.ts";
import {
  createHarnessInstallCommand,
  createHarnessUninstallCommand,
} from "./install.ts";

/**
 * Retained for the retired project-init integration step. Harness installation
 * itself is always mechanical; this compatibility wrapper has no side effects
 * beyond registering Claude's dormant integration.
 */
export async function runClaudeInstallFlow(
  _opts?: unknown,
  _globalOpts?: unknown,
): Promise<void> {
  await installHarness("claude");
}

/** Availability for the retired project-init integration step. */
export async function pluginInstallAvailable(): Promise<StepAvailability> {
  if (Bun.which("claude") === null) return "hidden";
  return isHarnessInstalled("claude") ? "done" : "available";
}

/**
 * Inject the frozen harness contract into Claude's sourced environment file.
 * This does not enable MCP or capture policy; it only preserves the session
 * project anchor for later runtime resolution.
 */
function createClaudeEnvCommand(): Command {
  return new Command("env")
    .description("internal Claude Code SessionStart hook")
    .action(async () => {
      let event: HookEvent = {};
      try {
        event = JSON.parse(await Bun.stdin.text()) as HookEvent;
      } catch {
        // A malformed event must never interrupt a Claude session.
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
 * Import a Claude transcript only when the machine-local capture policy selects
 * Claude for this session. The hook is best-effort and therefore always exits 0.
 */
function createClaudeHookCommand(): Command {
  return new Command("hook")
    .description("internal Claude Code capture hook")
    .requiredOption(
      "--event <name>",
      `hook event name (${HOOK_EVENT_NAMES.join(", ")})`,
    )
    .action(async (opts: { event: string }) => {
      const eventName = opts.event as HookEventName;
      if (!HOOK_EVENT_NAMES.includes(eventName)) process.exit(0);

      let event: HookEvent;
      try {
        event = JSON.parse(await Bun.stdin.text()) as HookEvent;
      } catch {
        process.exit(0);
      }

      const cwd =
        process.env.ME_PROJECT_DIR ??
        event.cwd ??
        process.env.CLAUDE_PROJECT_DIR;
      if (!cwd || !event.transcript_path) process.exit(0);

      let policy: CaptureSurface | undefined;
      try {
        policy = resolveCaptureProfile(cwd).value;
      } catch (error) {
        console.error(
          `[memory-engine] ${eventName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(0);
      }
      if (!policy?.enabled || policy.harnesses.claude !== true) process.exit(0);

      try {
        const creds = resolveCredentials(policy.server);
        if (!creds.apiKey && !creds.loggedIn) {
          console.error(
            "[memory-engine] capture is enabled but no credentials are available.",
          );
          process.exit(0);
        }
        const client = createMemoryClient({
          url: policy.server as string,
          ...memoryBearer(policy.server as string, creds.apiKey),
          space: policy.space as string,
        });
        await importTranscriptFile(
          client,
          claudeImporter,
          event.transcript_path,
          {
            treeRoot: policy.tree_root ?? DEFAULT_PRIVATE_TREE_ROOT,
            tree: policy.tree,
            sessionsNodeName: SESSIONS_NODE,
            fullTranscript: false,
            dryRun: false,
            verbose: false,
          },
        );
      } catch (error) {
        console.error(
          `[memory-engine] ${eventName} capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exit(0);
    });
}

export function createClaudeCommand(): Command {
  const claude = new Command("claude").description("Claude Code integration");
  claude.addCommand(createHarnessInstallCommand("claude"));
  claude.addCommand(createHarnessUninstallCommand("claude"));
  claude.addCommand(createClaudeEnvCommand());
  claude.addCommand(createClaudeHookCommand());
  claude.addCommand(createClaudeImportCommand());
  return claude;
}
