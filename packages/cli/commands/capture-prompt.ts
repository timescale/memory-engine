/**
 * The shared session-capture opt-in prompt, run by `me claude install` and
 * `me opencode install` after a successful session (non-headless) install.
 *
 * Capture is one machine-wide setting (config.yaml `capture`) shared by every
 * harness's hooks — the hooks ship inert until it (or a project's `.me`
 * `capture: true`) turns them on. Saying yes persists the flag and runs a
 * one-time machine-wide backfill of the harness's existing sessions, landing
 * per-project under the same private `~/projects/<slug>` nodes live capture
 * uses. Non-interactive runs leave the setting untouched (there is no prompt
 * to answer); a cancel leaves it untouched too.
 */
import * as clack from "@clack/prompts";
import { getGlobalCaptureEnabled, setCaptureEnabled } from "../credentials.ts";
import type { Importer } from "../importers/index.ts";
import { runAgentImport } from "./import.ts";

export async function runCapturePrompt(
  importer: Importer,
  globalOpts: Record<string, unknown>,
  opts: {
    /** Resolved space for the backfill; absent → the backfill is skipped. */
    space?: string;
    /** Harness label used in the prompt copy (e.g. "Claude Code"). */
    toolLabel: string;
    /** The install command to re-run to change the answer later. */
    installCmd: string;
  },
): Promise<void> {
  const interactive =
    Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!interactive) {
    if (!getGlobalCaptureEnabled()) {
      clack.log.info(
        "Session capture is off — the plugin provides the memory tools only. " +
          `Re-run '${opts.installCmd}' in a terminal to enable capture.`,
      );
    }
    return;
  }

  const wasEnabled = getGlobalCaptureEnabled();
  const answer = await clack.confirm({
    message:
      `Capture your ${opts.toolLabel} sessions as memories, machine-wide ` +
      "(every project, not just this one)? They stay private to you (saved " +
      "under ~/projects/<repo> inside memory engine) unless a project " +
      "explicitly shares them.",
    initialValue: wasEnabled,
  });
  if (clack.isCancel(answer)) {
    clack.log.info(
      `Capture left ${wasEnabled ? "on" : "off"} — re-run '${opts.installCmd}' to change it.`,
    );
    return;
  }
  setCaptureEnabled(answer);
  if (!answer) {
    clack.log.info(
      "Capture is off — the plugin provides the memory tools only. " +
        `Re-run '${opts.installCmd}' to enable it later.`,
    );
    return;
  }

  clack.log.success(
    "Capture is on. New sessions are captured privately to ~/projects/<repo>.",
  );
  if (!opts.space) {
    clack.log.warn(
      `No active space — skipping the session backfill. Run 'me space use <space>', then 'me import ${importer.tool}'.`,
    );
    return;
  }
  // One-time machine-wide backfill of existing sessions.
  clack.log.step(`Backfilling your existing ${opts.toolLabel} sessions...`);
  await runAgentImport(importer, {}, globalOpts);
}
