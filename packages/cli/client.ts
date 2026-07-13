/**
 * CLI-local wrapper around `@memory.build/client`.
 *
 * Auto-injects `CLIENT_VERSION` into every client/transport so the server
 * can run its `X-Client-Version` compatibility check. Otherwise re-exports
 * the upstream API verbatim — types, errors, helpers — so command files
 * import everything from one place.
 */
import {
  createMemoryClient as baseCreateMemoryClient,
  createUserClient as baseCreateUserClient,
  type MemoryClient,
  type MemoryClientOptions,
  type UserClient,
  type UserClientOptions,
} from "@memory.build/client";
import { CLIENT_VERSION } from "../../version";

/**
 * Memory client factory (space data-plane + management) with
 * `clientVersion: CLIENT_VERSION` injected. Talks to /api/v1/memory/rpc with the
 * active space carried as X-Me-Space.
 */
export function createMemoryClient(
  options: MemoryClientOptions = {},
): MemoryClient {
  return baseCreateMemoryClient({ clientVersion: CLIENT_VERSION, ...options });
}

/**
 * User client factory (agent lifecycle + space discovery + whoami) with
 * `clientVersion: CLIENT_VERSION` injected. Talks to /api/v1/user/rpc.
 */
export function createUserClient(options: UserClientOptions = {}): UserClient {
  return baseCreateUserClient({ clientVersion: CLIENT_VERSION, ...options });
}

// Re-export types and helpers used across the CLI. Pass-through so command
// files don't need to dual-import from "@memory.build/client".
export {
  type CheckServerVersionOptions,
  checkServerVersion,
  isRpcError,
  type MemoryClient,
  type MemoryClientOptions,
  type MemoryNamespace,
  RpcError,
  type UserClient,
  type UserClientOptions,
} from "@memory.build/client";
