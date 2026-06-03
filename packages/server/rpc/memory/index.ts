/**
 * Memory RPC method registry — served at `/api/v1/memory/rpc`.
 *
 * The new-model replacement for the engine RPC: memory data-plane methods
 * (spaceStore) and, in 4C-2, space management methods (coreStore). Memory.*
 * methods are wired here; management methods are added in Phase 4C-2.
 */
export { memoryMethods } from "./memory";
export {
  assertSpaceRpcContext,
  isSpaceRpcContext,
  type SpaceRpcContext,
} from "./types";
