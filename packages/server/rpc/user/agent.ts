/**
 * Agent handlers (agent.*) for the user RPC.
 *
 * Agents are a user's global service accounts. The lifecycle here is purely
 * user-scoped: create / list / rename / delete the caller's own agents.
 * Bringing an agent into a space (principal.add) and minting its space-bound
 * api key (apiKey.create) are space-endpoint operations.
 */
import type { Principal } from "@memory.build/engine/core";
import type {
  AgentCreateParams,
  AgentCreateResult,
  AgentDeleteParams,
  AgentDeleteResult,
  AgentListParams,
  AgentListResult,
  AgentRenameParams,
  AgentRenameResult,
  AgentResponse,
} from "@memory.build/protocol/user";
import {
  agentCreateParams,
  agentDeleteParams,
  agentListParams,
  agentRenameParams,
} from "@memory.build/protocol/user";
import { guardCore } from "../core-error";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertUserRpcContext, type UserRpcContext } from "./types";

function toAgentResponse(p: Principal): AgentResponse {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt?.toISOString() ?? null,
  };
}

/** Assert the caller owns this agent (globally). */
async function requireOwnAgent(
  ctx: UserRpcContext,
  agentId: string,
): Promise<void> {
  const principal = await ctx.core.getPrincipal(agentId);
  if (!principal || principal.kind !== "a") {
    throw new AppError("NOT_FOUND", `Agent not found: ${agentId}`);
  }
  if (principal.ownerId !== ctx.userId) {
    throw new AppError("FORBIDDEN", "Not the owner of this agent");
  }
}

async function agentCreate(
  params: AgentCreateParams,
  context: HandlerContext,
): Promise<AgentCreateResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const id = await guardCore(() =>
    ctx.core.createAgent(ctx.userId, params.name),
  );
  return { id };
}

async function agentList(
  _params: AgentListParams,
  context: HandlerContext,
): Promise<AgentListResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const agents = await ctx.core.listAgents(ctx.userId);
  return { agents: agents.map(toAgentResponse) };
}

async function agentRename(
  params: AgentRenameParams,
  context: HandlerContext,
): Promise<AgentRenameResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireOwnAgent(ctx, params.id);
  const renamed = await guardCore(() =>
    ctx.core.renamePrincipal(params.id, params.name),
  );
  return { renamed };
}

async function agentDelete(
  params: AgentDeleteParams,
  context: HandlerContext,
): Promise<AgentDeleteResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireOwnAgent(ctx, params.id);
  const deleted = await guardCore(() => ctx.core.deletePrincipal(params.id));
  return { deleted };
}

export const agentMethods = buildRegistry()
  .register("agent.create", agentCreateParams, agentCreate)
  .register("agent.list", agentListParams, agentList)
  .register("agent.rename", agentRenameParams, agentRename)
  .register("agent.delete", agentDeleteParams, agentDelete)
  .build();
