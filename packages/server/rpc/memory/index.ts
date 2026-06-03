/**
 * Memory RPC method registry — served at `/api/v1/memory/rpc`.
 *
 * The new-model replacement for the engine RPC: memory data-plane methods
 * (spaceStore) and space management methods (coreStore). Methods are added in
 * Phase 4C-1 (memory.*) and 4C-2 (user/grant/owner/role/apiKey.*); for now the
 * endpoint + authenticateSpace plumbing exists with an empty registry.
 */
import { buildRegistry } from "../registry";

export {
  assertSpaceRpcContext,
  isSpaceRpcContext,
  type SpaceRpcContext,
} from "./types";

export const memoryMethods = buildRegistry().build();
