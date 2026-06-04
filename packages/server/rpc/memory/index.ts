/**
 * Memory RPC method registry — served at `/api/v1/memory/rpc`.
 *
 * The new-model replacement for the engine RPC, combining the memory data-plane
 * methods (spaceStore) with the space management methods (coreStore): membership,
 * agents, groups, tree-access grants, and agent api keys.
 */
import type { MethodRegistry } from "../types";
import { apiKeyMethods } from "./api-key";
import { grantMethods } from "./grant";
import { groupMethods } from "./group";
import { memoryDataMethods } from "./memory";
import { principalMethods } from "./principal";

export {
  assertSpaceRpcContext,
  isSpaceRpcContext,
  type SpaceRpcContext,
} from "./types";

/**
 * The full memory-endpoint registry: data-plane + space management methods.
 * (Agent lifecycle lives on the user endpoint — see rpc/user.)
 */
export const memoryMethods: MethodRegistry = new Map([
  ...memoryDataMethods,
  ...principalMethods,
  ...groupMethods,
  ...grantMethods,
  ...apiKeyMethods,
]);
