/**
 * The shared per-project "enable ongoing capture" init step, used by
 * `me project init` and `me opencode init`.
 *
 * Selecting the step writes the COMMITTED `.me/config.yaml` `capture: true` —
 * the per-project opt-in every harness's hooks honor (it wins over each
 * member's machine-wide setting, so a committed config makes a team repo
 * capture for everyone). Interactively DESELECTING the row is an explicit
 * opt-out: {@link applyCaptureDeselection} writes `capture: false`, so the
 * committed config stays deterministic for the team (absent would fall back
 * to each member's global setting). Non-interactive `--skip-capture-enable`
 * means "don't touch", not "turn off".
 */
import * as clack from "@clack/prompts";
import {
  discoverProjectConfig,
  writeProjectConfig,
} from "../project-config.ts";
import type { InitStep, RunInitStepsResult } from "./init.ts";

/** Build the capture-enable step for a harness's init checklist. */
export function captureEnableStep(opts: {
  /** Picker group heading (e.g. "Claude Code sessions"). */
  group: string;
  /** Harness label used in the row copy (e.g. "Claude Code"). */
  toolLabel: string;
}): InitStep {
  return {
    id: "capture-enable",
    group: opts.group,
    kind: "ongoing",
    optionKey: "skipCaptureEnable",
    skipFlag: "--skip-capture-enable",
    skipDescription:
      "do not enable ongoing session capture for this project (capture: true)",
    label: `Enable ongoing capture of new ${opts.toolLabel} sessions for this project`,
    // ✓ when the project already pins capture: true. The capturing itself is
    // done by the installed plugin's hooks; this writes the committed flag
    // that turns them on for this project regardless of the member's global
    // setting.
    available: async ({ projectRoot }) =>
      discoverProjectConfig(projectRoot ?? process.cwd())?.capture === true
        ? "done"
        : "available",
    doneLabel: "Ongoing session capture already enabled for this project",
    rerunLabel: `Re-enable ongoing capture of new ${opts.toolLabel} sessions (already enabled)`,
    run: async ({ projectRoot }) => {
      const path = writeProjectConfig(projectRoot ?? process.cwd(), {
        capture: true,
      });
      clack.log.success(`Enabled session capture (capture: true) in ${path}`);
    },
  };
}

/**
 * After the checklist ran: when the capture row was OFFERED interactively but
 * neither selected nor already done, the user deliberately toggled it off —
 * write the explicit `capture: false`. No-op non-interactively (a `--skip` is
 * "don't touch") and when the step was hidden, ran, or already enabled.
 */
export function applyCaptureDeselection(
  result: RunInitStepsResult,
  opts: { interactive: boolean; projectRoot: string | undefined },
): void {
  if (!opts.interactive || !opts.projectRoot) return;
  const touched =
    result.ran.some((s) => s.id === "capture-enable") ||
    result.done.some((s) => s.id === "capture-enable");
  if (!result.offered.includes("capture-enable") || touched) return;
  const path = writeProjectConfig(opts.projectRoot, { capture: false });
  clack.log.info(
    `Ongoing session capture disabled for this project (capture: false) in ${path}`,
  );
}
