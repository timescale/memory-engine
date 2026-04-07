import type { JsonRpcError, JsonRpcErrorResponse } from "./types";

/**
 * JSON-RPC 2.0 protocol error codes.
 */
export const RPC_ERROR_CODES = {
  /** Invalid JSON was received by the server. */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object. */
  INVALID_REQUEST: -32600,
  /** The method does not exist / is not available. */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s). */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error. */
  INTERNAL_ERROR: -32603,
  /** Application-level error. */
  APPLICATION_ERROR: -32000,
} as const;

/**
 * Create a JSON-RPC error object.
 */
export function createRpcError(
  code: number,
  message: string,
  data?: { code: string; [key: string]: unknown },
): JsonRpcError {
  return data ? { code, message, data } : { code, message };
}

/**
 * Create a JSON-RPC error response.
 */
export function createErrorResponse(
  error: JsonRpcError,
  id: string | number | null,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    error,
    id,
  };
}

/**
 * Create a parse error response (-32700).
 * Used when the request body is not valid JSON.
 */
export function parseError(
  id: string | number | null = null,
): JsonRpcErrorResponse {
  return createErrorResponse(
    createRpcError(RPC_ERROR_CODES.PARSE_ERROR, "Parse error: invalid JSON"),
    id,
  );
}

/**
 * Create an invalid request error response (-32600).
 * Used when the JSON is not a valid JSON-RPC 2.0 request.
 */
export function invalidRequest(
  id: string | number | null = null,
  details?: string,
): JsonRpcErrorResponse {
  const message = details
    ? `Invalid request: ${details}`
    : "Invalid request: not a valid JSON-RPC 2.0 request";
  return createErrorResponse(
    createRpcError(RPC_ERROR_CODES.INVALID_REQUEST, message),
    id,
  );
}

/**
 * Create a method not found error response (-32601).
 */
export function methodNotFound(
  method: string,
  id: string | number,
): JsonRpcErrorResponse {
  return createErrorResponse(
    createRpcError(
      RPC_ERROR_CODES.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    ),
    id,
  );
}

/**
 * Create an invalid params error response (-32602).
 * Used when method params fail Zod validation.
 */
export function invalidParams(
  id: string | number,
  details: string,
): JsonRpcErrorResponse {
  return createErrorResponse(
    createRpcError(
      RPC_ERROR_CODES.INVALID_PARAMS,
      `Invalid params: ${details}`,
    ),
    id,
  );
}

/**
 * Create an internal error response (-32603).
 * Used for unexpected server errors.
 */
export function internalError(
  id: string | number | null,
  details?: string,
): JsonRpcErrorResponse {
  const message = details ? `Internal error: ${details}` : "Internal error";
  return createErrorResponse(
    createRpcError(RPC_ERROR_CODES.INTERNAL_ERROR, message),
    id,
  );
}

/**
 * Create an application error response (-32000).
 * Used for application-level errors with a string error code.
 */
export function applicationError(
  id: string | number,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcErrorResponse {
  return createErrorResponse(
    createRpcError(RPC_ERROR_CODES.APPLICATION_ERROR, message, {
      code,
      ...data,
    }),
    id,
  );
}

/**
 * Common application error codes.
 */
export const APP_ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type AppErrorCode =
  (typeof APP_ERROR_CODES)[keyof typeof APP_ERROR_CODES];

/**
 * Application error that handlers can throw.
 * The RPC handler will catch this and convert to a proper JSON-RPC error response.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Type guard for AppError.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Helper to create common application errors.
 */
export const appErrors = {
  unauthorized: (id: string | number, message = "Unauthorized") =>
    applicationError(id, APP_ERROR_CODES.UNAUTHORIZED, message),

  forbidden: (id: string | number, message = "Forbidden") =>
    applicationError(id, APP_ERROR_CODES.FORBIDDEN, message),

  notFound: (id: string | number, resource: string) =>
    applicationError(id, APP_ERROR_CODES.NOT_FOUND, `${resource} not found`),

  conflict: (id: string | number, message: string) =>
    applicationError(id, APP_ERROR_CODES.CONFLICT, message),

  rateLimited: (id: string | number) =>
    applicationError(id, APP_ERROR_CODES.RATE_LIMITED, "Rate limit exceeded"),

  validationError: (id: string | number, message: string) =>
    applicationError(id, APP_ERROR_CODES.VALIDATION_ERROR, message),
};
