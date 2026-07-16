/**
 * Memory RPC method registry — served at `/api/v1/memory/rpc`.
 *
 * The new-model replacement for the engine RPC, combining the memory data-plane
 * methods (spaceStore) with the space management methods (coreStore): membership,
 * groups, tree-access grants, and invitations.
 */
import type { MethodRegistry } from "../types";
import { accessMethods } from "./access";
import { grantMethods } from "./grant";
import { groupMethods } from "./group";
import { invitationMethods } from "./invitation";
import { memoryDataMethods } from "./memory";
import { principalMethods } from "./principal";
import { activeSpaceMethods } from "./space";

export {
  assertSpaceRpcContext,
  isSpaceRpcContext,
  type SpaceRpcContext,
} from "./types";

/**
 * The full memory-endpoint registry: data-plane + space management methods.
 * (Agent lifecycle and api keys live on the user endpoint — see rpc/user.)
 */
export const memoryMethods: MethodRegistry = new Map([
  ...memoryDataMethods,
  ...activeSpaceMethods,
  ...accessMethods,
  ...principalMethods,
  ...groupMethods,
  ...grantMethods,
  ...invitationMethods,
]);
