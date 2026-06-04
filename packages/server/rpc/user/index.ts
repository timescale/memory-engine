/**
 * User RPC method registry — served at `/api/v1/user/rpc` (session-only,
 * user-scoped). Currently the lifecycle of a user's agents.
 */
import type { MethodRegistry } from "../types";
import { agentMethods } from "./agent";
import { spaceMethods } from "./space";

export {
  assertUserRpcContext,
  isUserRpcContext,
  type UserRpcContext,
} from "./types";

/** The user-endpoint registry: agent lifecycle + space discovery. */
export const userMethods: MethodRegistry = new Map([
  ...agentMethods,
  ...spaceMethods,
]);
