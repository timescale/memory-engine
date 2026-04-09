/**
 * JSON-RPC 2.0 envelope types.
 *
 * Defines the wire format for all RPC exchanges between client and server.
 */

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
