/**
 * @memory.build/protocol — shared schema package for Memory Engine.
 *
 * Single source of truth for all RPC request/response types between
 * client and server. Both the server (validation) and client libraries
 * (type inference + optional response validation) import from here.
 *
 * Two RPC endpoints, two contracts:
 *   - Engine RPC (POST /api/v1/engine/rpc) — API key auth, 30 methods
 *   - Accounts RPC (POST /api/v1/accounts/rpc) — session token auth, 19 methods
 */

// Accounts RPC contract + all accounts schemas
export * from "./accounts/index.ts";
// Device flow auth schemas
export * from "./auth/device-flow.ts";
// Engine RPC contract + all engine schemas
export * from "./engine/index.ts";
// Error codes and AppError
export * from "./errors.ts";
// Shared field validators
export * from "./fields.ts";
// JSON-RPC 2.0 envelope types
export * from "./jsonrpc.ts";
