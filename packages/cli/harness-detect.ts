/**
 * Harness detection — is a coding agent (Claude Code, opencode, Codex, Gemini
 * CLI, or an agent we have no integration for) invoking `me`, or a human?
 *
 * This is the shell surface's backstop signal (see HARNESS_DESIGN.md
 * "Enforcement by harness" / surface (c)): the injected `ME_INJECT_V`
 * liveness var is the primary evidence when our own adapters are live;
 * `detectHarness()` covers the case where injection silently didn't run
 * (untrusted Codex hooks, an uninstalled plugin, a harness we've never
 * integrated with) by reading each harness's own native env markers.
 *
 * `@vercel/detect-agent` packages most of this matrix (checking the generic
 * `AI_AGENT` convention first, then per-harness markers). We wrap it rather
 * than call it directly for one reason: it does not check opencode's
 * terminal-launched markers (`OPENCODE=1` / `AGENT=1` — only
 * `OPENCODE_CLIENT`, set by the desktop app and ACP mode), so we add that
 * check ourselves rather than wait on upstream.
 *
 * Detection is one-directional: evidence of a harness forces agent-or-die (see
 * the failsafe), but the ABSENCE of evidence proves nothing — `me` then runs
 * as the human. Over-detection fails in the safe direction too: agent mode is
 * privilege-*reducing* (the `agent_tree_access` clamp), so a false positive
 * acts as the agent (or fails closed), never escalates.
 */
import { determineAgent } from "@vercel/detect-agent";

/** Result of harness detection. */
export interface HarnessDetection {
  /** Whether some coding-agent harness appears to be invoking `me`. */
  isAgent: boolean;
  /**
   * The harness's name, when known — e.g. "claude", "opencode", "codex",
   * "gemini" (native-marker naming; our own injected `AI_AGENT` uses
   * "gemini-cli" for Gemini — see harness-contract.ts). Undefined when
   * `isAgent` is false.
   */
  agent?: string;
}

/**
 * Detect whether a coding-agent harness is invoking the current process.
 * Wraps `@vercel/detect-agent`'s `determineAgent()` (which already checks the
 * `AI_AGENT` convention first — the same name our own adapters inject — then
 * per-harness native markers) with our own backstop for opencode's
 * terminal-launched CLI/TUI path.
 */
export async function detectHarness(): Promise<HarnessDetection> {
  const result = await determineAgent();
  if (result.isAgent) return { isAgent: true, agent: result.agent?.name };

  // Backstop: opencode's CLI middleware exports OPENCODE=1 / AGENT=1 / into
  // its own env (inherited by every child), but stock detect-agent only
  // checks OPENCODE_CLIENT (set by the desktop app / ACP mode, not the
  // terminal-launched CLI/TUI path). Undocumented internals, so we keep this
  // as our own backstop rather than waiting on an upstream fix.
  if (process.env.OPENCODE === "1" || process.env.AGENT === "1") {
    return { isAgent: true, agent: "opencode" };
  }

  return { isAgent: false };
}
