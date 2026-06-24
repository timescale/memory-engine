/**
 * @memory.build/protocol — shared schema package for Memory Engine.
 *
 * Single source of truth for all RPC request/response types between
 * client and server. Both the server (validation) and client libraries
 * (type inference + optional response validation) import from here.
 *
 * RPC endpoints / contracts:
 *   - Memory RPC (POST /api/v1/memory/rpc) — session or api-key auth; the memory
 *     data plane (./memory) + the space management contract (./space).
 *   - User RPC (POST /api/v1/user/rpc) — session auth; whoami + agent + space
 *     discovery (./user).
 */

// Error codes and AppError
export * from "./errors.ts";
// Shared field validators
export * from "./fields.ts";
// HTTP header names
export * from "./headers.ts";
// JSON-RPC 2.0 envelope types
export * from "./jsonrpc.ts";
// Memory data-plane schemas
export * from "./memory.ts";
// Version compatibility schemas
export * from "./version.ts";
