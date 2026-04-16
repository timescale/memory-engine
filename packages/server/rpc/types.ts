/**
 * RPC types — re-exports protocol types and defines server-internal types.
 *
 * JSON-RPC envelope types come from @memory.build/protocol.
 * Server-internal types (HandlerContext, MethodHandler, etc.) are defined here.
 */
import type { z } from "zod";

// Re-export JSON-RPC 2.0 envelope types from protocol
export type {
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from "@memory.build/protocol/jsonrpc";

// =============================================================================
// Server-Internal Types
// =============================================================================

/**
 * Context passed to method handlers.
 */
export interface HandlerContext {
  /** The raw request object */
  request: Request;
  /** Additional context (auth info, etc.) */
  [key: string]: unknown;
}

/**
 * Method handler function signature.
 */
export type MethodHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: HandlerContext,
) => Promise<TResult> | TResult;

/**
 * Registered method with schema and handler.
 */
export interface RegisteredMethod<TParams = unknown, TResult = unknown> {
  /** Zod schema for validating params */
  schema: z.ZodType<TParams>;
  /** Handler function */
  handler: MethodHandler<TParams, TResult>;
}

/**
 * Method registry - maps method names to handlers.
 */
export type MethodRegistry = Map<string, RegisteredMethod>;
