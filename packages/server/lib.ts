// packages/server/lib.ts
// Type exports for consumers who need to test or extend the server

export type { ServerContext } from "./context";
export {
  type AccountsAuthContext,
  type AuthContext,
  type AuthResult,
  authenticateAccounts,
  authenticateEngine,
  ENGINE_SCHEMA_PREFIX,
  type EngineAuthContext,
} from "./middleware";
export { createRouter, type Router } from "./router";
