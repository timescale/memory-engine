import { buildRegistry } from "../registry";
import { memoryMethods } from "./memory";

/**
 * Engine RPC method registry.
 *
 * Chunk 3 (current) - Memory methods:
 * - memory.create, memory.batchCreate, memory.get, memory.update, memory.delete
 * - memory.search, memory.tree, memory.move, memory.deleteTree
 *
 * Chunk 4 - User, grant, role methods:
 * - user.create, user.get, user.list, user.update, user.delete
 * - grant.create, grant.list, grant.revoke
 * - role.create, role.addMember, role.removeMember, role.listMembers
 *
 * Chunk 5 - API key methods:
 * - apiKey.create, apiKey.list, apiKey.revoke
 */
export const engineMethods = buildRegistry().merge(memoryMethods).build();

// Re-export types for consumers
export type { EngineContext } from "./types";
export { assertEngineContext, isEngineContext } from "./types";
