/**
 * User RPC method registry — served at `/api/v1/user/rpc` (session-only,
 * user-scoped): the lifecycle of a user's agents and their global api keys.
 */
import type { MethodRegistry } from "../types";
import { agentMethods } from "./agent";
import { apiKeyMethods } from "./api-key";
import { spaceMethods } from "./space";
import { whoamiMethods } from "./whoami";

export {
  assertUserRpcContext,
  isUserRpcContext,
  type UserRpcContext,
} from "./types";

/**
 * The user-endpoint registry: identity + agent lifecycle + api keys + space
 * discovery.
 */
export const userMethods: MethodRegistry = new Map([
  ...whoamiMethods,
  ...agentMethods,
  ...apiKeyMethods,
  ...spaceMethods,
]);
