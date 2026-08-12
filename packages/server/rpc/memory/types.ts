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
  /** Authenticated principal id. */
  principalId: string;
  /** Authenticated principal kind. */
  principalKind: "u" | "s";
  /** Authenticated principal display name. */
  principalName: string;
  /** Api key id when authenticated by api key; null for sessions. */
  apiKeyId: string | null;
  /** API key display name when authenticated by one. */
  apiKeyName: string | null;
  /** The principal's effective grants in this space. May be empty. */
  treeAccess: TreeAccess;
  /** Whether the principal is a space admin (principal_space.admin). */
  admin: boolean;
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
    "principalKind" in ctx &&
    (ctx.principalKind === "u" || ctx.principalKind === "s") &&
    "principalName" in ctx &&
    typeof ctx.principalName === "string" &&
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
