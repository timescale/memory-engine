/**
 * The install-time default-agent step: every harness install (`me claude
 * install`, `me opencode install`) runs {@link ensureDefaultAgent} so "no
 * agent anywhere" is rare in practice — agent-by-config's fatal-on-nothing
 * (`me mcp`) and skip-on-nothing (hooks) degrade gracefully only because
 * most machines have picked up a default here.
 *
 * No-op when a global `agent:` is already set (including the `.user`
 * opt-out) or the credential is already an agent api key (the sandboxed
 * `ME_API_KEY` mode already IS an agent — nothing to provision). Otherwise:
 * adopt the caller's existing `coder` agent if one exists, else create it
 * with a whole-space WRITE grant (clamped by the owner's own access) and
 * admit it to the active space; write the resolved name as the global
 * `agent:`.
 *
 * A fixed name (rather than prompting) keeps docs/errors concrete, and —
 * since `agent:` resolves by name against the caller's own agents — a second
 * machine's install adopts the same agent automatically. Deliberate
 * per-project agent choice stays in `me project init`.
 */
import * as clack from "@clack/prompts";
import {
  getGlobalAgent,
  type ResolvedCredentials,
  setGlobalAgent,
} from "../credentials.ts";
import { buildMemoryClient, buildUserClient } from "../util.ts";
import { ensureAgentInSpace, provisionNewAgent } from "./provision.ts";

/** The fixed default-agent name every install adopts-or-creates. */
export const DEFAULT_AGENT_NAME = "coder";

/**
 * Ensure a global default agent is configured, per the module doc. Silent
 * no-op in every case where provisioning isn't possible or isn't this
 * install's business (headless, not logged in, no active space to admit
 * into) — the harness-surface fatal errors (`me mcp`) name the fix later
 * rather than this step guessing at one.
 *
 * Set `perProjectStepFollows` when calling this from inside `me project
 * init` (its preflight delegates to `me claude install`/`me opencode
 * install`, which call this) — the closing note's "or run `me project
 * init` for a per-project choice" line is genuinely useful advice for a
 * standalone install, but confusing and redundant when it fires from
 * *inside* that exact command, moments before its own agent-choice step.
 */
export async function ensureDefaultAgent(
  creds: ResolvedCredentials,
  opts?: { perProjectStepFollows?: boolean },
): Promise<void> {
  if (creds.apiKey) return; // sandboxed agent-key mode — already IS an agent
  if (getGlobalAgent() !== undefined) return; // already decided (incl. .user)
  if (!creds.loggedIn || !creds.activeSpace) return; // nothing to provision yet

  const user = buildUserClient(creds);
  const memory = buildMemoryClient({
    ...creds,
    activeSpace: creds.activeSpace,
  });
  const { agents } = await user.agent.list();
  const existing = agents.find(
    (a) => a.name.toLowerCase() === DEFAULT_AGENT_NAME,
  );

  if (existing) {
    // `agent.list()` is global, not scoped to the active space — an existing
    // "coder" could be from a different space, or have had its grant
    // revoked. Ensure it actually has access HERE before adopting it;
    // both calls are idempotent, so this is a no-op when it's already set up.
    await ensureAgentInSpace(
      { memory },
      existing.id,
      "", // whole-space WRITE grant, clamped by the owner's own access
    );
    setGlobalAgent(existing.name);
  } else {
    await provisionNewAgent(
      { user, memory },
      DEFAULT_AGENT_NAME,
      "", // whole-space WRITE grant, clamped by the owner's own access
    );
    setGlobalAgent(DEFAULT_AGENT_NAME);
  }

  const closingLines = opts?.perProjectStepFollows
    ? [
        "and you can restrict its access at any time. To use a different agent",
        "globally, set `agent:` in ~/.config/me/config.yaml — this project's own",
        "agent choice comes up next.",
      ]
    : [
        "and you can restrict its access at any time. To use a different agent,",
        "set `agent:` in ~/.config/me/config.yaml or run `me project init` for a",
        "per-project choice.",
      ];
  clack.note(
    [
      `Coding harnesses will act as your Memory Engine agent "${DEFAULT_AGENT_NAME}" —`,
      "a separate identity from you, with write access to everything you can",
      "reach by default. Its work is attributable (not filed under your name),",
      ...closingLines,
    ].join("\n"),
    "Default agent",
  );
}
