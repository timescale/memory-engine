/**
 * Agent method schemas (agent.*) for the user RPC.
 *
 * Agents are user-owned non-human principals (names unique per user, not scoped
 * to a space). Their lifecycle lives on the user endpoint
 * (POST /api/v1/user/rpc); bringing an agent into a space is an in-space
 * operation, and api keys are global per-principal credentials.
 */
import { z } from "zod";
import { principalHandleNameSchema, uuidv7Schema } from "../fields.ts";
import { memberSpaceResponse } from "./space.ts";

export const agentResponse = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type AgentResponse = z.infer<typeof agentResponse>;

// agent.create — create an agent owned by the calling user
export const agentCreateParams = z.object({ name: principalHandleNameSchema });
export type AgentCreateParams = z.infer<typeof agentCreateParams>;

export const agentCreateResult = z.object({ id: z.string() });
export type AgentCreateResult = z.infer<typeof agentCreateResult>;

// agent.list — the caller's agents
export const agentListParams = z.object({});
export type AgentListParams = z.infer<typeof agentListParams>;

export const agentListResult = z.object({ agents: z.array(agentResponse) });
export type AgentListResult = z.infer<typeof agentListResult>;

// agent.spaces — spaces an owned agent belongs to
export const agentSpacesParams = z.object({ id: uuidv7Schema });
export type AgentSpacesParams = z.infer<typeof agentSpacesParams>;

export const agentSpacesResult = z.object({
  spaces: z.array(memberSpaceResponse),
});
export type AgentSpacesResult = z.infer<typeof agentSpacesResult>;

// agent.rename
export const agentRenameParams = z.object({
  id: uuidv7Schema,
  name: principalHandleNameSchema,
});
export type AgentRenameParams = z.infer<typeof agentRenameParams>;

export const agentRenameResult = z.object({ renamed: z.boolean() });
export type AgentRenameResult = z.infer<typeof agentRenameResult>;

// agent.delete
export const agentDeleteParams = z.object({ id: uuidv7Schema });
export type AgentDeleteParams = z.infer<typeof agentDeleteParams>;

export const agentDeleteResult = z.object({ deleted: z.boolean() });
export type AgentDeleteResult = z.infer<typeof agentDeleteResult>;
