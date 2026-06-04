/**
 * User RPC contract — session-only, user-scoped methods served on
 * POST /api/v1/user/rpc. Covers the lifecycle of a user's global service
 * accounts (agents); space membership and api keys live on the space endpoint.
 */
import type { z } from "zod";

import {
  agentCreateParams,
  agentCreateResult,
  agentDeleteParams,
  agentDeleteResult,
  agentListParams,
  agentListResult,
  agentRenameParams,
  agentRenameResult,
} from "./agent.ts";
import {
  spaceCreateParams,
  spaceCreateResult,
  spaceDeleteParams,
  spaceDeleteResult,
  spaceListParams,
  spaceListResult,
  spaceRenameParams,
  spaceRenameResult,
} from "./space.ts";

export * from "./agent.ts";
export * from "./space.ts";

function method<TParams extends z.ZodType, TResult extends z.ZodType>(
  params: TParams,
  result: TResult,
) {
  return { params, result };
}

/** User RPC method contract (agent lifecycle + space discovery). */
export const userMethods = {
  "agent.create": method(agentCreateParams, agentCreateResult),
  "agent.list": method(agentListParams, agentListResult),
  "agent.rename": method(agentRenameParams, agentRenameResult),
  "agent.delete": method(agentDeleteParams, agentDeleteResult),

  "space.list": method(spaceListParams, spaceListResult),
  "space.create": method(spaceCreateParams, spaceCreateResult),
  "space.rename": method(spaceRenameParams, spaceRenameResult),
  "space.delete": method(spaceDeleteParams, spaceDeleteResult),
} as const;

export type UserMethodName = keyof typeof userMethods;
export type UserParams<M extends UserMethodName> = z.infer<
  (typeof userMethods)[M]["params"]
>;
export type UserResult<M extends UserMethodName> = z.infer<
  (typeof userMethods)[M]["result"]
>;
