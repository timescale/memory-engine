/**
 * Shared `init` engine for agent integrations (`me claude init`,
 * `me opencode init`).
 *
 * Setup is a list of independent steps, grouped by source — each source pairs a
 * one-time backfill of existing data with ongoing capture going forward. In an
 * interactive terminal `init` presents a grouped multiselect of all steps (each
 * pre-checked) so the user can deselect any; non-interactively it runs every
 * step except those turned off by a `--skip-<step>` flag. To add a step, append
 * one entry to the command's step list — it picks up a `--skip-*` flag and a
 * picker row (under its `group` heading) automatically.
 *
 * Only the step list and outro copy differ per agent; everything else (option
 * wiring, availability probing, the picker, execution, the recap) lives here.
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { getOutputFormat } from "../output.ts";

/** Dim (secondary text) ANSI, for de-emphasizing hint copy. `\x1b[22m` resets
 * only the dim attribute so surrounding clack styling is left intact. */
export const DIM = "\x1b[2m";
export const DIM_OFF = "\x1b[22m";

/** Green checkmark (resets only the foreground color) for already-done init
 * steps, matching clack's green log symbols. */
export const CHECK = "\x1b[32m✓\x1b[39m";

export interface InitStepContext {
  /** Global CLI opts (carries --server, output format) for the step to use. */
  globalOpts: Record<string, unknown>;
  /** Resolved server URL, if any. */
  server?: string;
  /** Install scope, when the agent supports one (e.g. OpenCode project/user). */
  scope?: string;
  /** Project root for a "project" scope (git root, else cwd). */
  projectRoot?: string;
}

/**
 * Availability of an init step in this environment: offer it, hide it entirely
 * (not applicable here), or report it as already done.
 */
export type StepAvailability = "available" | "hidden" | "done";

export interface InitStep {
  /** Stable id — the multiselect value and the basis of the --skip flag. */
  id: string;
  /** Picker group heading — steps sharing a group render under one header. */
  group: string;
  /**
   * What the step contributes: a one-time "backfill" of historical data,
   * "ongoing" capture of new activity (hooks), or plain "config". Drives the
   * outro's recap of what init covered.
   */
  kind: "backfill" | "ongoing" | "config";
  /** Commander-parsed key for this step's skip flag (e.g. skipGitHook). */
  optionKey: string;
  /** The skip flag (e.g. "--skip-git-hook"). */
  skipFlag: string;
  /** Help text for the skip flag. */
  skipDescription: string;
  /** Multiselect row label. */
  label: string;
  /**
   * Optional availability gate: "hidden" omits the step entirely; "done" keeps
   * it out of non-interactive runs (reported as a ✓ `doneLabel` line) and offers
   * it unchecked in the picker. Absent means always available.
   */
  available?: (ctx: InitStepContext) => Promise<StepAvailability>;
  /** The ✓ line printed when `available` resolves "done". */
  doneLabel?: string;
  /** Picker row label when already done — offered unchecked as an idempotent
   * re-run. Falls back to `label`. */
  rerunLabel?: string;
  /** Perform the step. */
  run: (ctx: InitStepContext) => Promise<void>;
}

/**
 * The outro's lead recap: whether init performed a one-time import of historical
 * data, set up ongoing capture, or both. Empty when neither applies (e.g. only a
 * memory pointer ran).
 */
export function initOutroLead(steps: Pick<InitStep, "kind">[]): string[] {
  const backfill = steps.some((s) => s.kind === "backfill");
  const ongoing = steps.some((s) => s.kind === "ongoing");
  if (backfill && ongoing) {
    return [
      "Imported this project's historical data (past sessions, git",
      "history), and set up hooks that keep it updated going forward —",
      "new sessions and commits are captured automatically.",
      "",
    ];
  }
  if (backfill) {
    return [
      "Imported this project's historical data (past sessions, git",
      "history) — a one-time backfill.",
      "",
    ];
  }
  if (ongoing) {
    return [
      "Set up hooks that capture new sessions and commits going forward.",
      "",
    ];
  }
  return [];
}

/** What one {@link runInitSteps} pass covered. */
export interface RunInitStepsResult {
  /** Steps that ran (the picker selection / the non-interactive baseline). */
  ran: InitStep[];
  /** Steps reported already done. */
  done: InitStep[];
  /** Ids of every step offered (runnable + already-done rerun rows). */
  offered: string[];
}

/**
 * Probe availability, (interactively) present the grouped step picker, and
 * run the selection — the engine behind every `init` command, shared so
 * `me project init` can run the checklist after its own wizard phase.
 * Interactive: a multiselect pre-checked with the baseline (every available
 * step not `--skip-*`ed). Non-interactive: the baseline runs as-is, with
 * already-done steps reported as ✓ lines. Exits the process on a picker
 * cancel.
 */
export async function runInitSteps(
  steps: InitStep[],
  ctx: InitStepContext,
  env: { interactive: boolean; fmt: string; cmdOpts: Record<string, unknown> },
): Promise<RunInitStepsResult> {
  const { interactive, fmt, cmdOpts } = env;

  // Steps available in this environment. Already-done steps get a ✓ line
  // instead of a row. The probe is skipped for steps already opted out
  // non-interactively, so a `--skip-<step>` run never pays for that probe.
  const candidates: InitStep[] = [];
  const doneSteps: InitStep[] = [];
  for (const step of steps) {
    if (!interactive && cmdOpts[step.optionKey] === true) continue;
    const availability = step.available
      ? await step.available(ctx)
      : "available";
    if (availability === "hidden") continue;
    if (availability === "done") {
      doneSteps.push(step);
      continue;
    }
    candidates.push(step);
  }
  if (fmt === "text" && !interactive) {
    doneSteps.forEach((step, i) => {
      clack.log.message(step.doneLabel ?? step.label, {
        symbol: CHECK,
        spacing: i === 0 ? 1 : 0,
      });
    });
  }

  // Baseline = every available step not turned off via its --skip-* flag.
  const baseline = candidates.filter((s) => cmdOpts[s.optionKey] !== true);

  const doneIds = new Set(doneSteps.map((s) => s.id));
  // Picker rows: runnable steps plus already-done ones (offered unchecked, as
  // idempotent re-runs), in step order so each row sits in its group section.
  const rows = steps.filter((s) => candidates.includes(s) || doneIds.has(s.id));
  const rowLabel = (step: InitStep): string =>
    doneIds.has(step.id) ? (step.rerunLabel ?? step.label) : step.label;

  let selectedIds: string[];
  if (interactive) {
    const grouped: Record<string, clack.Option<string>[]> = {};
    for (const step of rows) {
      const groupRows = grouped[step.group] ?? [];
      groupRows.push({ value: step.id, label: rowLabel(step) });
      grouped[step.group] = groupRows;
    }
    const picked = await clack.groupMultiselect<string>({
      message: `Setup steps to run ${DIM}(all selected by default — ↑/↓ move, space to toggle off/on, enter to confirm)${DIM_OFF}`,
      options: grouped,
      initialValues: baseline.map((s) => s.id),
      required: false,
      selectableGroups: false,
    });
    if (clack.isCancel(picked)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    selectedIds = picked;
  } else {
    selectedIds = baseline.map((s) => s.id);
  }

  const selected = rows.filter((s) => selectedIds.includes(s.id));
  const offered = rows.map((s) => s.id);
  if (selected.length === 0) {
    clack.log.info("No setup steps selected — nothing to do.");
    return { ran: [], done: doneSteps, offered };
  }

  for (const step of selected) {
    if (fmt === "text") clack.log.step(rowLabel(step));
    await step.run(ctx);
  }
  return { ran: selected, done: doneSteps, offered };
}

/** Build an `init` Command from a per-agent step list + outro renderer. */
export function buildInitCommand(opts: {
  description: string;
  steps: InitStep[];
  /** Renders the closing note; receives everything covered (ran + already done). */
  outro: (covered: InitStep[]) => void;
  /** Extra CLI options to register (e.g. `--scope <scope>`). */
  options?: Array<{
    flags: string;
    description: string;
    /** Optional commander arg parser (validates/transforms the value). */
    argParser?: (value: string, previous: unknown) => unknown;
  }>;
  /**
   * Optional hook to augment the step context before availability probing —
   * e.g. resolve + (interactively) prompt for an install scope. Runs once after
   * `interactive` is known, so availability probes and steps see the result.
   */
  resolveContext?: (
    base: InitStepContext,
    cmdOpts: Record<string, unknown>,
    env: { interactive: boolean; fmt: string },
  ) => Promise<InitStepContext>;
}): Command {
  const { steps: INIT_STEPS, outro } = opts;
  const cmd = new Command("init").description(opts.description);
  // One --skip-<step> flag per step, so non-interactive runs can opt out.
  for (const step of INIT_STEPS) {
    cmd.option(step.skipFlag, step.skipDescription);
  }
  // Agent-specific extra options (e.g. --scope).
  for (const opt of opts.options ?? []) {
    if (opt.argParser) {
      cmd.option(opt.flags, opt.description, opt.argParser);
    } else {
      cmd.option(opt.flags, opt.description);
    }
  }
  cmd.action(async (cmdOpts: Record<string, unknown>, cmdRef: Command) => {
    const globalOpts = cmdRef.optsWithGlobals();
    const server =
      typeof globalOpts.server === "string" ? globalOpts.server : undefined;
    const fmt = getOutputFormat(globalOpts);

    // Interactive (a TTY with text output): present a multiselect pre-checked
    // with the baseline so the user can deselect steps. Otherwise run the
    // baseline as-is.
    const interactive =
      fmt === "text" &&
      Boolean(process.stdin.isTTY) &&
      Boolean(process.stdout.isTTY);

    let ctx: InitStepContext = { globalOpts, server };
    if (opts.resolveContext) {
      ctx = await opts.resolveContext(ctx, cmdOpts, { interactive, fmt });
    }
    const { ran, done } = await runInitSteps(INIT_STEPS, ctx, {
      interactive,
      fmt,
      cmdOpts,
    });
    if (ran.length === 0) return;
    // The recap covers what just ran plus what was already in place.
    if (fmt === "text") outro([...ran, ...done]);
  });
  return cmd;
}
