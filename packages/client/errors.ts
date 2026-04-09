/**
 * Client-side error types.
 */

/**
 * Error thrown when the server returns a JSON-RPC error response.
 *
 * The `code` is the numeric JSON-RPC error code (e.g., -32602 for invalid params,
 * -32000 for application errors). For application errors, `data.code` contains
 * the string error code (e.g., "NOT_FOUND", "FORBIDDEN").
 */
export class RpcError extends Error {
  /** JSON-RPC numeric error code */
  readonly code: number;
  /** Additional error data (includes string `code` for application errors) */
  readonly data?: { code: string; [key: string]: unknown };

  constructor(
    code: number,
    message: string,
    data?: { code: string; [key: string]: unknown },
  ) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  /**
   * The application error code (e.g., "NOT_FOUND"), if this is an application error.
   */
  get appCode(): string | undefined {
    return this.data?.code;
  }

  /**
   * Whether this is a specific application error code.
   */
  is(code: string): boolean {
    return this.data?.code === code;
  }
}

/**
 * Type guard for RpcError.
 */
export function isRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError;
}
