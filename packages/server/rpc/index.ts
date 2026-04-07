// Method registries
export { accountsMethods } from "./accounts";
export {
  assertEngineContext,
  type EngineContext,
  engineMethods,
  isEngineContext,
} from "./engine";

// Errors
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
} from "./errors";

// Handler
export { createRpcHandler, handleRpcRequest } from "./handler";
// Registry
export {
  buildRegistry,
  createRegistry,
  getMethod,
  hasMethod,
  listMethods,
  RegistryBuilder,
  registerMethod,
} from "./registry";
export type {
  HandlerContext,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  MethodHandler,
  MethodRegistry,
  RegisteredMethod,
} from "./types";
