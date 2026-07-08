/**
 * Memory RPC context types.
 *
 * The context for `/api/v1/memory/rpc` — populated by authenticateSpace. Memory
 * (data-plane) methods use `store` + `treeAccess`; management (control-plane)
 * methods use `core` + `space`. Endpoint admission is direct space membership,
 * so `treeAccess` may be empty.
 */
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { CoreStore, Space, TreeAccess } from "@memory.build/engine/core";
import type { SpaceStore } from "@memory.build/engine/space";
import type { HandlerContext } from "../types";

export interface SpaceRpcContext extends HandlerContext {
  /** Space data-plane store bound to the `me_<slug>` schema. */
  store: SpaceStore;
  /** Core control-plane store (management methods). */
  core: CoreStore;
  /** The resolved space. */
  space: Space;
  /** Authenticated principal id (user id for sessions, agent id for api keys). */
  principalId: string;
  /**
   * The principal's owner — non-null when it is an agent, null for a user. Drives
   * `~` home nesting (an agent's home lives under its owner's home).
   */
  ownerId: string | null;
  /** Api key id when authenticated by api key; null for sessions. */
  apiKeyId: string | null;
  /** The principal's effective grants in this space. May be empty. */
  treeAccess: TreeAccess;
  /** Whether the principal is a space admin (principal_space.admin). */
  admin: boolean;
  /**
   * When a human is acting as one of their own agents (via `X-Me-As-Agent`),
   * the human's principal id; null otherwise. Observability only — authorization
   * reads the (already switched) `principalId` / `ownerId` / `treeAccess` / `admin`.
   */
  authenticatedAs: string | null;
  /** Embedding config for semantic search (optional). */
  embeddingConfig?: EmbeddingConfig;
}

/**
 * Type guard for the memory RPC context.
 */
export function isSpaceRpcContext(ctx: HandlerContext): ctx is SpaceRpcContext {
  return (
    "store" in ctx &&
    typeof ctx.store === "object" &&
    ctx.store !== null &&
    "core" in ctx &&
    typeof ctx.core === "object" &&
    ctx.core !== null &&
    "space" in ctx &&
    typeof ctx.space === "object" &&
    ctx.space !== null &&
    "principalId" in ctx &&
    typeof ctx.principalId === "string" &&
    "treeAccess" in ctx &&
    Array.isArray(ctx.treeAccess)
  );
}

/**
 * Assert that context is a SpaceRpcContext, throwing if not.
 */
export function assertSpaceRpcContext(
  ctx: HandlerContext,
): asserts ctx is SpaceRpcContext {
  if (!isSpaceRpcContext(ctx)) {
    throw new Error("Space context not initialized (authentication required)");
  }
}
