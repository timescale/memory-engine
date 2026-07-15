/**
 * The install-time default-agent step: every harness install (`me claude
 * install`, `me opencode install`) runs {@link ensureDefaultAgent} so "no
 * agent anywhere" is rare in practice — agent-by-config's fatal-on-nothing
 * (`me mcp`) and skip-on-nothing (hooks) degrade gracefully only because
 * most machines have picked up a default here.
 *
 * No-op when a non-default global `agent:` already points at an owned agent,
 * the global `.user` opt-out is set, or the credential is already an agent api
 * key (the sandboxed `ME_API_KEY` mode already IS an agent — nothing to
 * provision). Otherwise: adopt the caller's existing `coder` agent if one
 * exists, else create it with a whole-space WRITE grant (clamped by the
 * owner's own access) and admit it to the active space; write the resolved
 * name as the global `agent:`.
 *
 * The default path uses a fixed name (rather than prompting), which keeps
 * docs/errors concrete; since `agent:` resolves by name against the caller's
 * own agents, a second machine's install adopts the same agent automatically.
 * Deliberate per-project agent choice stays in `me project init`.
 */
import * as clack from "@clack/prompts";
import {
  getGlobalAgent,
  type ResolvedCredentials,
  RUN_AS_USER_SENTINEL,
  setGlobalAgent,
} from "../credentials.ts";
import { buildMemoryClient, buildUserClient } from "../util.ts";
import {
  type AgentProvisioningClients,
  ensureAgentInSpace,
  provisionNewAgent,
} from "./provision.ts";

/** The fixed default-agent name every install adopts-or-creates. */
export const DEFAULT_AGENT_NAME = "coder";

interface ListedAgent {
  id: string;
  name: string;
}

interface DefaultAgentClients extends AgentProvisioningClients {
  user: AgentProvisioningClients["user"] & {
    agent: AgentProvisioningClients["user"]["agent"] & {
      list(): Promise<{ agents: ListedAgent[] }>;
    };
  };
}

type AgentResolution =
  | { kind: "found"; agent: ListedAgent }
  | { kind: "not_found" }
  | { kind: "ambiguous" };

function resolveOwnedAgent(
  agents: ListedAgent[],
  agent: string,
): AgentResolution {
  const wanted = agent.toLowerCase();
  const matches = agents.filter(
    (a) => a.id.toLowerCase() === wanted || a.name.toLowerCase() === wanted,
  );
  const unique = new Map(matches.map((a) => [a.id, a]));
  if (unique.size === 0) return { kind: "not_found" };
  if (unique.size > 1) return { kind: "ambiguous" };
  const [match] = unique.values();
  return match ? { kind: "found", agent: match } : { kind: "not_found" };
}

function staleConfiguredAgentMessage(agent: string): string {
  return (
    `Global config says harnesses should run as agent '${agent}', ` +
    "but you do not own an agent with that name or id. " +
    `Create it, or change 'agent:' in ~/.config/me/config.yaml.`
  );
}

function ambiguousConfiguredAgentMessage(agent: string): string {
  return (
    `Global config agent '${agent}' matches multiple agents you own. ` +
    "Rename the conflicting agent, or change 'agent:' in ~/.config/me/config.yaml."
  );
}

async function confirmCreateConfiguredAgent(agent: string): Promise<boolean> {
  clack.log.warn(staleConfiguredAgentMessage(agent));
  const answer = await clack.confirm({
    message: `Create '${agent}' now and grant it write access in the active space?`,
    initialValue: agent.toLowerCase() === DEFAULT_AGENT_NAME,
  });
  if (clack.isCancel(answer)) return false;
  return answer;
}

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
  opts?: {
    perProjectStepFollows?: boolean;
    clients?: DefaultAgentClients;
    confirmCreateConfiguredAgent?: (agent: string) => Promise<boolean>;
    interactive?: boolean;
  },
): Promise<void> {
  if (creds.apiKey) return; // sandboxed agent-key mode — already IS an agent
  const configuredAgent = getGlobalAgent();
  if (configuredAgent === RUN_AS_USER_SENTINEL) return; // explicit user-mode
  if (!creds.loggedIn || !creds.activeSpace) return; // nothing to provision yet

  const clients = opts?.clients ?? {
    user: buildUserClient(creds),
    memory: buildMemoryClient({
      ...creds,
      activeSpace: creds.activeSpace,
    }),
  };
  const { user, memory } = clients;
  const { agents } = await user.agent.list();
  const targetAgent = configuredAgent ?? DEFAULT_AGENT_NAME;
  const existing = resolveOwnedAgent(agents, targetAgent);

  if (existing.kind === "ambiguous") {
    throw new Error(ambiguousConfiguredAgentMessage(targetAgent));
  }

  if (
    configuredAgent !== undefined &&
    existing.kind === "found" &&
    configuredAgent.toLowerCase() !== DEFAULT_AGENT_NAME
  ) {
    return;
  }

  const createMissingConfiguredAgent =
    configuredAgent !== undefined && existing.kind === "not_found";
  if (createMissingConfiguredAgent) {
    const interactive =
      opts?.interactive ??
      (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
    if (!interactive) throw new Error(staleConfiguredAgentMessage(targetAgent));

    const shouldCreate = await (
      opts?.confirmCreateConfiguredAgent ?? confirmCreateConfiguredAgent
    )(targetAgent);
    if (!shouldCreate) {
      clack.log.warn(
        `Default agent not created. Harnesses configured with agent: ${targetAgent} will fail until you create that agent or change ~/.config/me/config.yaml.`,
      );
      return;
    }
  }

  const defaultExisting =
    existing.kind === "found" &&
    targetAgent.toLowerCase() === DEFAULT_AGENT_NAME
      ? existing.agent
      : undefined;
  let noteAgent = targetAgent;

  if (defaultExisting) {
    // `agent.list()` is global, not scoped to the active space — an existing
    // "coder" could be from a different space, or have had its grant
    // revoked. Ensure it actually has access HERE before adopting it;
    // both calls are idempotent, so this is a no-op when it's already set up.
    await ensureAgentInSpace(
      { memory },
      defaultExisting.id,
      "", // whole-space WRITE grant, clamped by the owner's own access
    );
    if (configuredAgent === undefined) setGlobalAgent(defaultExisting.name);
    noteAgent = defaultExisting.name;
  } else {
    await provisionNewAgent(
      { user, memory },
      targetAgent,
      "", // whole-space WRITE grant, clamped by the owner's own access
    );
    if (configuredAgent === undefined) setGlobalAgent(targetAgent);
  }

  if (configuredAgent !== undefined && !createMissingConfiguredAgent) return;

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
      `Coding harnesses will act as your Memory Engine agent "${noteAgent}" —`,
      "a separate identity from you, with write access to everything you can",
      "reach by default. Its work is attributable (not filed under your name),",
      ...closingLines,
    ].join("\n"),
    "Default agent",
  );
}
