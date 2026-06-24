/**
 * Agent handlers (agent.*) for the user RPC.
 *
 * Agents are a user's global service accounts. The lifecycle here is purely
 * user-scoped: create / list / rename / delete the caller's own agents, and
 * mint their (global) api keys (apiKey.* — see ./api-key.ts). Bringing an agent
 * into a space (principal.add) is a space-endpoint operation.
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
  AgentSpacesParams,
  AgentSpacesResult,
} from "@memory.build/protocol/user";
import {
  agentCreateParams,
  agentDeleteParams,
  agentListParams,
  agentRenameParams,
  agentSpacesParams,
} from "@memory.build/protocol/user";
import { guardCore } from "../core-error";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { toMemberSpaceResponse } from "./space";
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
export async function requireOwnAgent(
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

/**
 * Assert the caller may manage api keys for this member — either their own user
 * principal (a personal access token) or an agent they own.
 */
export async function requireOwnMember(
  ctx: UserRpcContext,
  memberId: string,
): Promise<void> {
  if (memberId === ctx.userId) return; // the caller's own user principal (PAT)
  await requireOwnAgent(ctx, memberId); // else must be an agent they own
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

async function agentSpaces(
  params: AgentSpacesParams,
  context: HandlerContext,
): Promise<AgentSpacesResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireOwnAgent(ctx, params.id);
  const spaces = await ctx.core.listSpacesForMember(params.id);
  return { spaces: spaces.map(toMemberSpaceResponse) };
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
  .register("agent.spaces", agentSpacesParams, agentSpaces)
  .register("agent.rename", agentRenameParams, agentRename)
  .register("agent.delete", agentDeleteParams, agentDelete)
  .build();
