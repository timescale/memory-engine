/**
 * Engine RPC context types.
 *
 * Extends the base HandlerContext with engine-specific fields.
 */
import type { EngineDB } from "@memory-engine/engine";
import type { HandlerContext } from "../types";

/**
 * Engine handler context.
 *
 * Provides access to:
 * - `db`: EngineDB instance for the authenticated engine
 * - `userId`: The authenticated user's ID (from API key)
 *
 * Authentication middleware (chunk 5) populates these fields.
 * Until then, handlers should validate that required fields exist.
 */
export interface EngineContext extends HandlerContext {
  /** EngineDB instance for this engine */
  db: EngineDB;
  /** Authenticated user ID */
  userId: string;
}

/**
 * Type guard to check if context has engine fields.
 */
export function isEngineContext(ctx: HandlerContext): ctx is EngineContext {
  return (
    "db" in ctx &&
    typeof ctx.db === "object" &&
    ctx.db !== null &&
    "userId" in ctx &&
    typeof ctx.userId === "string"
  );
}

/**
 * Assert that context is an EngineContext, throwing if not.
 */
export function assertEngineContext(
  ctx: HandlerContext,
): asserts ctx is EngineContext {
  if (!isEngineContext(ctx)) {
    throw new Error("Engine context not initialized (authentication required)");
  }
}
