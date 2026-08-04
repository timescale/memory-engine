/**
 * me codex — Codex CLI integration commands.
 *
 * - me codex install: register me as an MCP server with Codex CLI.
 * - me codex env-hook: available for shared integration wiring as its
 *   user-scope PreToolUse hook to rewrite Bash commands.
 */
import { Command } from "commander";
import { createMemoryClient } from "../client.ts";
import { buildCodexEnvHookOutput } from "../codex/env-hook.ts";
import { resolveCredentials } from "../credentials.ts";
import { logUnrecognizedPayloadShape } from "../harness-shape-log.ts";
import { codexImporter } from "../importers/codex.ts";
import {
  DEFAULT_PRIVATE_TREE_ROOT,
  DEFAULT_SESSIONS_NODE_NAME,
  importTranscriptFile,
} from "../importers/index.ts";
import { type CaptureSurface, resolveCaptureProfile } from "../local-config.ts";
import { memoryBearer } from "../session.ts";
import { createCodexImportCommand } from "./import.ts";
import {
  createHarnessInstallCommand,
  createHarnessUninstallCommand,
} from "./install.ts";

function createCodexInstallCommand(): Command {
  return createHarnessInstallCommand("codex");
}

/**
 * me codex env-hook — invoked by the PreToolUse hook installed above.
 * Reads the payload from stdin, and for a Bash tool call prints a rewrite
 * that prepends the harness contract's `export …; ` prefix to the command.
 * Fails open (empty stdout) on anything it doesn't recognize — a malformed
 * payload, or a shape update from Codex — logging the shape (never command
 * content) so a later `me doctor` can flag it. Always exits 0: a hook
 * failure must never block a Codex turn.
 */
function createCodexEnvHookCommand(): Command {
  return new Command("env-hook")
    .description(
      "invoked by Codex's PreToolUse hook to inject the harness contract into Bash commands",
    )
    .action(async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(await Bun.stdin.text());
      } catch {
        logUnrecognizedPayloadShape("codex", undefined);
        process.exit(0);
      }

      const result = buildCodexEnvHookOutput(payload, process.env);
      if (result.unrecognizedShape) {
        logUnrecognizedPayloadShape("codex", payload);
      }
      if (result.output) {
        console.log(JSON.stringify(result.output));
      }
      process.exit(0);
    });
}

const CAPTURE_EVENTS = ["Stop", "SessionEnd"] as const;
type CaptureEvent = (typeof CAPTURE_EVENTS)[number];

interface CodexCapturePayload {
  cwd?: string;
  transcript_path?: string | null;
}

/** Import the current Codex transcript only when local policy selects capture. */
function createCodexCaptureHookCommand(): Command {
  return new Command("hook")
    .description("internal Codex transcript capture hook")
    .requiredOption(
      "--event <name>",
      `hook event name (${CAPTURE_EVENTS.join(", ")})`,
    )
    .action(async (opts: { event: string }) => {
      if (!CAPTURE_EVENTS.includes(opts.event as CaptureEvent)) process.exit(0);

      let payload: CodexCapturePayload;
      try {
        payload = JSON.parse(await Bun.stdin.text()) as CodexCapturePayload;
      } catch {
        process.exit(0);
      }
      const cwd = payload.cwd ?? process.env.ME_PROJECT_DIR;
      if (!cwd || typeof payload.transcript_path !== "string") process.exit(0);

      let policy: CaptureSurface | undefined;
      try {
        policy = resolveCaptureProfile(cwd).value;
      } catch (error) {
        console.error(
          `[memory-engine] ${opts.event}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(0);
      }
      if (!policy?.enabled || policy.harnesses.codex !== true) process.exit(0);
      if (!policy.server || !policy.space) process.exit(0);

      try {
        const creds = resolveCredentials(policy.server);
        if (!creds.apiKey && !creds.loggedIn) process.exit(0);
        const client = createMemoryClient({
          url: policy.server,
          ...memoryBearer(policy.server, creds.apiKey),
          space: policy.space,
        });
        await importTranscriptFile(
          client,
          codexImporter,
          payload.transcript_path,
          {
            treeRoot: policy.tree_root ?? DEFAULT_PRIVATE_TREE_ROOT,
            tree: policy.tree,
            sessionsNodeName: DEFAULT_SESSIONS_NODE_NAME,
            fullTranscript: false,
            dryRun: false,
            verbose: false,
          },
        );
      } catch (error) {
        console.error(
          `[memory-engine] ${opts.event} capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exit(0);
    });
}

export function createCodexCommand(): Command {
  const codex = new Command("codex").description("Codex CLI integration");
  codex.addCommand(createCodexInstallCommand());
  codex.addCommand(createHarnessUninstallCommand("codex"));
  codex.addCommand(createCodexEnvHookCommand());
  codex.addCommand(createCodexCaptureHookCommand());
  codex.addCommand(createCodexImportCommand());
  return codex;
}
