import { buildRegistry } from "../registry";

/**
 * Engine RPC method registry.
 *
 * Methods will be added in chunks 3-5:
 *
 * Chunk 3 - Memory methods:
 * - memory.create, memory.batchCreate, memory.get, memory.update, memory.delete
 * - memory.search
 *
 * Chunk 4 - Tree, user, grant, role methods:
 * - memory.tree, memory.move, memory.deleteTree
 * - user.create, user.get, user.list, user.update, user.delete
 * - grant.create, grant.list, grant.revoke
 * - role.create, role.addMember, role.removeMember, role.listMembers
 *
 * Chunk 5 - API key methods:
 * - apiKey.create, apiKey.list, apiKey.revoke
 */
export const engineMethods = buildRegistry().build();
