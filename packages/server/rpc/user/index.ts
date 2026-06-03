/**
 * User RPC method registry — served at `/api/v1/user/rpc` (session-only,
 * user-scoped). Currently the lifecycle of a user's agents.
 */
import { agentMethods } from "./agent";

export {
  assertUserRpcContext,
  isUserRpcContext,
  type UserRpcContext,
} from "./types";

export const userMethods = agentMethods;
