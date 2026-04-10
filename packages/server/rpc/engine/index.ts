import { buildRegistry } from "../registry";
import { apiKeyMethods } from "./api-key";
import { grantMethods } from "./grant";
import { memoryMethods } from "./memory";
import { ownerMethods } from "./owner";
import { roleMethods } from "./role";
import { userMethods } from "./user";

/**
 * Engine RPC method registry.
 *
 * Memory methods (chunk 3):
 * - memory.create, memory.batchCreate, memory.get, memory.update, memory.delete
 * - memory.search, memory.tree, memory.move, memory.deleteTree
 *
 * User, grant, role methods (chunk 4):
 * - user.create, user.get, user.getByName, user.list, user.rename, user.delete
 * - grant.create, grant.list, grant.get, grant.revoke, grant.check
 * - role.create, role.addMember, role.removeMember, role.listMembers, role.listForUser
 *
 * API key methods (chunk 5):
 * - apiKey.create, apiKey.get, apiKey.list, apiKey.revoke, apiKey.delete
 */
export const engineMethods = buildRegistry()
  .merge(memoryMethods)
  .merge(userMethods)
  .merge(grantMethods)
  .merge(ownerMethods)
  .merge(roleMethods)
  .merge(apiKeyMethods)
  .build();

// Re-export types for consumers
export type { EngineContext } from "./types";
export { assertEngineContext, isEngineContext } from "./types";
