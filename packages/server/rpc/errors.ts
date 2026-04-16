/**
 * Re-export all error types and helpers from @memory.build/protocol.
 *
 * This module is kept as a re-export layer so that existing server code
 * can continue importing from "./errors" without changes.
 */
export {
  APP_ERROR_CODES,
  AppError,
  type AppErrorCode,
  appErrors,
  applicationError,
  createErrorResponse,
  createRpcError,
  internalError,
  invalidParams,
  invalidRequest,
  isAppError,
  methodNotFound,
  parseError,
  RPC_ERROR_CODES,
} from "@memory.build/protocol/errors";
