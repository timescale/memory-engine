/**
 * Shared agent-provisioning primitive: create an agent, add it to a space,
 * grant it WRITE at a tree path. Used by `me project init`'s per-project
 * agent step and `ensureDefaultAgent()`'s machine-wide default — pulled out
 * to its own leaf module so the latter doesn't need to import `commands/
 * project.ts` (which itself imports the Claude install flow) just for this.
 */

/** The client slices {@link provisionNewAgent} needs (injectable for tests). */
export interface AgentProvisioningClients {
  user: { agent: { create(p: { name: string }): Promise<{ id: string }> } };
  memory: {
    principal: { add(p: { principalId: string }): Promise<unknown> };
    grant: {
      set(p: {
        principalId: string;
        treePath: string;
        access: 1 | 2 | 3;
      }): Promise<unknown>;
    };
  };
}

/**
 * Ensure `principalId` is a member of the space (the memory client is pinned
 * to the chosen space) and holds a WRITE (2) grant at `treePath` — `""` for
 * the whole space, else a project tree. Write, not owner: a coding agent
 * reads/writes memories but shouldn't manage access; the server clamps an
 * agent to least(agent, owner) per path, so a root grant gives it exactly
 * what the caller can reach. Both calls are idempotent server-side, so this
 * is safe to call unconditionally — for a brand-new agent as much as for one
 * that already has access here.
 */
export async function ensureAgentInSpace(
  clients: Pick<AgentProvisioningClients, "memory">,
  principalId: string,
  treePath: string,
): Promise<void> {
  await clients.memory.principal.add({ principalId });
  await clients.memory.grant.set({ principalId, treePath, access: 2 });
}

/**
 * Provision a new agent: create it, then {@link ensureAgentInSpace}. Returns
 * the new agent's id.
 */
export async function provisionNewAgent(
  clients: AgentProvisioningClients,
  name: string,
  treePath: string,
): Promise<string> {
  const { id } = await clients.user.agent.create({ name });
  await ensureAgentInSpace(clients, id, treePath);
  return id;
}
