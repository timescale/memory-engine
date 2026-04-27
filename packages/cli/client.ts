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
  type ClientOptions,
  type EngineClient,
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
  RpcError,
} from "@memory.build/client";
