/**
 * @memory.build/protocol — shared schema package for Memory Engine.
 *
 * Single source of truth for all RPC request/response types between
 * client and server. Both the server (validation) and client libraries
 * (type inference + optional response validation) import from here.
 *
 * RPC endpoints / contracts:
 *   - Memory RPC (POST /api/v1/memory/rpc) — OAuth access token, api-key bearer
 *     (user PAT, agent key, or service-account key), or cookie session, plus a
 *     required X-Me-Space header; the memory data plane (./memory) + the space
 *     management contract (./space).
 *   - User RPC (POST /api/v1/user/rpc) — OAuth access token, cookie session, or
 *     the user's own PAT; agent/service-account keys are admitted only for the
 *     allow-listed reads (whoami, space.list), and key mint/revoke stays
 *     session-only. whoami + agent/service-account lifecycle + space discovery
 *     (./user).
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
// Reserved thread-link meta keys + canonical memory-path builder
export * from "./meta.ts";
// Version compatibility schemas
export * from "./version.ts";
