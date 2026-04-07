import type { z } from "zod";

/**
 * JSON-RPC 2.0 request object.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: string | number;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: {
    code: string;
    [key: string]: unknown;
  };
}

/**
 * JSON-RPC 2.0 success response.
 */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  result: unknown;
  id: string | number;
}

/**
 * JSON-RPC 2.0 error response.
 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  error: JsonRpcError;
  id: string | number | null;
}

/**
 * JSON-RPC 2.0 response (success or error).
 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

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
