import type { Principal } from "@memory.build/engine/core";

export type ActAsAgentResolution =
  | { kind: "found"; agent: Principal }
  | { kind: "not_found" }
  | { kind: "ambiguous" };

/** Resolve an X-Me-As-Agent value without silently preferring id over name. */
export function resolveOwnedAgent(
  agents: Principal[],
  asAgent: string,
): ActAsAgentResolution {
  const wanted = asAgent.toLowerCase();
  const matches = agents.filter(
    (agent) =>
      agent.id.toLowerCase() === wanted || agent.name.toLowerCase() === wanted,
  );
  const unique = new Map(matches.map((agent) => [agent.id, agent]));

  if (unique.size === 0) return { kind: "not_found" };
  if (unique.size > 1) return { kind: "ambiguous" };

  const [agent] = unique.values();
  if (!agent) return { kind: "not_found" };
  return { kind: "found", agent };
}
