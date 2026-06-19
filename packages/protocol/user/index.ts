/**
 * User RPC contract — session-only, user-scoped methods served on
 * POST /api/v1/user/rpc. Covers the lifecycle of a user's global service
 * accounts (agents) and their global api keys; space membership lives on the
 * space endpoint.
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
  agentSpacesParams,
  agentSpacesResult,
} from "./agent.ts";
import {
  apiKeyCreateParams,
  apiKeyCreateResult,
  apiKeyDeleteParams,
  apiKeyDeleteResult,
  apiKeyGetParams,
  apiKeyGetResult,
  apiKeyListParams,
  apiKeyListResult,
} from "./api-key.ts";
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
import { whoamiParams, whoamiResult } from "./whoami.ts";

export * from "./agent.ts";
export * from "./api-key.ts";
export * from "./space.ts";
export * from "./whoami.ts";

function method<TParams extends z.ZodType, TResult extends z.ZodType>(
  params: TParams,
  result: TResult,
) {
  return { params, result };
}

/**
 * User RPC method contract (identity + agent lifecycle + api keys + space
 * discovery).
 */
export const userMethods = {
  whoami: method(whoamiParams, whoamiResult),

  "agent.create": method(agentCreateParams, agentCreateResult),
  "agent.list": method(agentListParams, agentListResult),
  "agent.spaces": method(agentSpacesParams, agentSpacesResult),
  "agent.rename": method(agentRenameParams, agentRenameResult),
  "agent.delete": method(agentDeleteParams, agentDeleteResult),

  "apiKey.create": method(apiKeyCreateParams, apiKeyCreateResult),
  "apiKey.list": method(apiKeyListParams, apiKeyListResult),
  "apiKey.get": method(apiKeyGetParams, apiKeyGetResult),
  "apiKey.delete": method(apiKeyDeleteParams, apiKeyDeleteResult),

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
