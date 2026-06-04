/**
 * CLI-local wrapper around `@memory.build/client`.
 *
 * Auto-injects `CLIENT_VERSION` into every client/transport so the server
 * can run its `X-Client-Version` compatibility check. Otherwise re-exports
 * the upstream API verbatim — types, errors, helpers — so command files
 * import everything from one place.
 */
import {
  type AccountsClient,
  type AccountsClientOptions,
  type AuthClient,
  type AuthClientOptions,
  createAccountsClient as baseCreateAccountsClient,
  createAuthClient as baseCreateAuthClient,
  createClient as baseCreateClient,
  createMemoryClient as baseCreateMemoryClient,
  createUserClient as baseCreateUserClient,
  type ClientOptions,
  type EngineClient,
  type MemoryClient,
  type MemoryClientOptions,
  type UserClient,
  type UserClientOptions,
} from "@memory.build/client";
import { CLIENT_VERSION } from "../../version";

/**
 * Engine client factory with `clientVersion: CLIENT_VERSION` injected.
 */
export function createClient(options: ClientOptions = {}): EngineClient {
  return baseCreateClient({ clientVersion: CLIENT_VERSION, ...options });
}

/**
 * Accounts client factory with `clientVersion: CLIENT_VERSION` injected.
 */
export function createAccountsClient(
  options: AccountsClientOptions = {},
): AccountsClient {
  return baseCreateAccountsClient({
    clientVersion: CLIENT_VERSION,
    ...options,
  });
}

/**
 * Auth client factory.
 *
 * The device-flow endpoints don't go through the JSON-RPC pipeline, so they
 * don't currently observe `X-Client-Version`. Re-exported here for symmetry
 * so command files have a single import point.
 */
export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  return baseCreateAuthClient(options);
}

/**
 * Memory client factory (new model: space data-plane + management) with
 * `clientVersion: CLIENT_VERSION` injected. Talks to /api/v1/memory/rpc with the
 * active space carried as X-Me-Space.
 */
export function createMemoryClient(
  options: MemoryClientOptions = {},
): MemoryClient {
  return baseCreateMemoryClient({ clientVersion: CLIENT_VERSION, ...options });
}

/**
 * User client factory (new model: agent lifecycle + space discovery) with
 * `clientVersion: CLIENT_VERSION` injected. Talks to /api/v1/user/rpc.
 */
export function createUserClient(options: UserClientOptions = {}): UserClient {
  return baseCreateUserClient({ clientVersion: CLIENT_VERSION, ...options });
}

// Re-export types and helpers used across the CLI. Pass-through so command
// files don't need to dual-import from "@memory.build/client".
export {
  type AccountsClient,
  type AccountsClientOptions,
  type AuthClient,
  type AuthClientOptions,
  type CheckServerVersionOptions,
  type ClientOptions,
  checkServerVersion,
  DeviceFlowError,
  type EngineClient,
  isRpcError,
  type MemoryClient,
  type MemoryClientOptions,
  RpcError,
  type UserClient,
  type UserClientOptions,
} from "@memory.build/client";
