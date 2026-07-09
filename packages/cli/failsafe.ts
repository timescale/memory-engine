/**
 * The harness shell failsafe (HARNESS_DESIGN.md, "(c) Shell — injected env,
 * with a fail-closed detection failsafe").
 *
 * A plain `me` invocation from an agent's tool shell must never silently run
 * as the human — either the harness-injected contract is live (agent-by-config
 * activates normally), or `me` fails loudly. This module is the CLI-side half
 * of that guarantee: when a harness is DETECTED (native marker, or our own
 * `AI_AGENT` convention) but the injected contract's liveness var
 * (`ME_INJECT_V`) is absent, something is wrong — an uninstalled adapter, a
 * Codex hook still awaiting `/hooks` trust approval, a harness we've never
 * integrated with — and the safe default is a hard error, never the user's
 * credentials.
 *
 * Exemptions (see {@link isCheaplyExempt} / the surface allowlist below):
 * our own harness-surface commands (`me mcp`, `me <harness> hook`/`env-hook`)
 * enforce the stronger agent-by-config rule themselves and may run without
 * shell injection; a small diagnostic/setup allowlist; an explicit
 * `--as-agent`/`ME_AS_AGENT` (any value, including `.user` — the universal
 * human override); a CONFIRMED agent `ME_API_KEY` (the sanctioned sandbox
 * mode — the bearer already *is* the agent). "Confirmed" matters: a user PAT
 * uses the identical key format, so `ME_API_KEY` being set is only a claim —
 * {@link checkHarnessFailsafe} resolves the actual kind over the network,
 * and only pays for that round trip once a harness is actually detected (see
 * {@link ApiKeyKindResolver}). A live injected contract is itself an
 * exemption (nothing to fail over). And — decided in the design — an
 * INTERACTIVE stderr TTY is treated as a human in an IDE integrated terminal
 * (a harness tool shell never allocates one), not an error: run as the user
 * with a one-line notice.
 */

import { isInjectionLive } from "./harness-contract.ts";
import type { HarnessDetection } from "./harness-detect.ts";
import { detectHarness } from "./harness-detect.ts";

/**
 * Command paths (space-joined, e.g. "claude hook") exempt from the failsafe:
 * our own harness surfaces (they enforce agent-by-config themselves and may
 * run without shell injection) plus a small diagnostic/setup allowlist.
 */
const ALLOWLISTED_COMMANDS: ReadonlySet<string> = new Set([
  "mcp",
  "claude env",
  "claude hook",
  "opencode hook",
  "codex env-hook",
  "codex hook",
  "gemini env-hook",
  "gemini hook",
  "doctor",
  "login",
  "logout",
  "whoami",
  "version",
  "upgrade",
  "completions",
  "claude install",
  "opencode install",
  "opencode init",
  "codex install",
  "gemini install",
  "project init",
]);

/**
 * Best-effort mapping from a detected harness to the install command that
 * fixes a dead integration, for the harnesses we have an installer for.
 *
 * Not a simple exact-name lookup: `@vercel/detect-agent` checks the generic
 * `AI_AGENT` env var FIRST, and real-world harnesses set it to their own
 * value rather than one of detect-agent's own native-marker names — e.g.
 * Claude Code itself sets `AI_AGENT=claude-code_<version>_agent`, not the
 * bare string "claude" (confirmed empirically). So this matches by substring
 * against the detected name first, then falls back to the RAW native-marker
 * env vars directly — independent of whatever `AI_AGENT` says — so a
 * harness-specific value never masks a harness we actually support.
 */
function guessInstallHint(
  agent: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const name = agent?.toLowerCase() ?? "";
  if (name.includes("claude") || name.includes("cowork")) {
    return "me claude install";
  }
  if (name.includes("opencode")) return "me opencode install";
  if (name.includes("codex")) return "me codex install";
  if (name.includes("gemini")) return "me gemini install";

  if (env.CLAUDECODE || env.CLAUDE_CODE) return "me claude install";
  if (env.OPENCODE_CLIENT || env.OPENCODE === "1" || env.AGENT === "1") {
    return "me opencode install";
  }
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_THREAD_ID) {
    return "me codex install";
  }
  if (env.GEMINI_CLI) return "me gemini install";

  return undefined;
}

export type FailsafeVerdict =
  | { action: "ok" }
  | { action: "notice"; message: string }
  | { action: "error"; message: string };

export interface FailsafeInputs {
  /** The space-joined command path, e.g. "claude hook", "memory search". */
  commandPath: string;
  env: NodeJS.ProcessEnv;
  /** Whether --as-agent / ME_AS_AGENT was explicitly given (any value). */
  hasExplicitAsAgent: boolean;
  /**
   * Whether `ME_API_KEY` / `--api-key` is set to *something* — this is only
   * a claim, not proof it's an agent key: a user PAT is the identical
   * `me.<lookupId>.<secret>` format, so confirming which one it is needs a
   * network round trip (see {@link checkHarnessFailsafe}'s
   * `resolveIsAgentApiKey`).
   */
  hasApiKeyClaim: boolean;
  /** Whether stderr is an interactive TTY. */
  isStderrTTY: boolean;
}

/** The cheap (sync, no detection, no network) exemptions — checked before
 * paying for `detectHarness()`'s env scan (+ possible fs access) or a
 * network round trip. */
function isCheaplyExempt(inputs: FailsafeInputs): boolean {
  return (
    ALLOWLISTED_COMMANDS.has(inputs.commandPath) ||
    inputs.hasExplicitAsAgent ||
    isInjectionLive(inputs.env)
  );
}

/**
 * Pure decision core: given the cheap inputs, an already-computed harness
 * detection, and whether an api-key claim has been CONFIRMED to belong to an
 * agent (see {@link checkHarnessFailsafe}), decide what the failsafe does.
 * Split from {@link checkHarnessFailsafe} so tests can supply a synthetic
 * detection result without faking the env vars `detectHarness()` itself
 * reads (that matrix is covered by harness-detect.test.ts), and can pass the
 * confirmed-agent-key fact directly without a network call.
 */
export function decideFailsafe(
  inputs: FailsafeInputs,
  detection: HarnessDetection,
  confirmedAgentApiKey = false,
): FailsafeVerdict {
  if (isCheaplyExempt(inputs)) return { action: "ok" };
  if (confirmedAgentApiKey) return { action: "ok" };
  if (!detection.isAgent) return { action: "ok" }; // no evidence → human (goal 2)

  if (inputs.isStderrTTY) {
    // A human in an IDE integrated terminal: a harness marker without live
    // injection there means a human, not an agent (tool shells never
    // allocate a TTY). Run as the user with a one-line notice.
    return {
      action: "notice",
      message:
        `[memory-engine] running as you: ${detection.agent ?? "a coding harness"} marker detected, but this looks like an ` +
        "interactive terminal (not an agent's tool shell) — treating it as you. Pass --as-agent to run as an agent instead.",
    };
  }

  const installHint = guessInstallHint(detection.agent, inputs.env);
  if (installHint) {
    return {
      action: "error",
      message:
        `[memory-engine] refusing to run as you: ${detection.agent} appears to be invoking 'me', but its integration isn't active here ` +
        `(no injected contract). Run '${installHint}' to fix this.`,
    };
  }
  return {
    action: "error",
    message:
      "[memory-engine] refusing to run as you: a coding agent" +
      (detection.agent ? ` (${detection.agent})` : "") +
      " appears to be invoking 'me', but memory-engine has no integration for it yet. " +
      "Please file a GitHub issue at https://github.com/timescale/memory-engine/issues requesting support.",
  };
}

/**
 * Confirms whether the current api-key claim actually belongs to an agent
 * (vs a user PAT) — the two are byte-identical in shape, so only the server
 * can tell them apart. Callers should swallow their own errors and resolve
 * `false` (fail closed: an unconfirmed claim is never treated as an agent).
 */
export type ApiKeyKindResolver = () => Promise<boolean>;

/**
 * Run the full failsafe check: skip harness detection when a cheap
 * exemption already applies; otherwise detect, and — only when a harness IS
 * detected AND there's an api-key claim to confirm — pay for one network
 * round trip (`resolveIsAgentApiKey`) before deciding. This keeps the common
 * paths (no harness detected at all; no api key) free of any network call.
 */
export async function checkHarnessFailsafe(
  inputs: FailsafeInputs,
  resolveIsAgentApiKey?: ApiKeyKindResolver,
): Promise<FailsafeVerdict> {
  if (isCheaplyExempt(inputs)) return { action: "ok" };
  const detection = await detectHarness();
  if (!detection.isAgent) return { action: "ok" };

  const confirmedAgentApiKey =
    inputs.hasApiKeyClaim && resolveIsAgentApiKey
      ? await resolveIsAgentApiKey().catch(() => false)
      : false;
  return decideFailsafe(inputs, detection, confirmedAgentApiKey);
}
