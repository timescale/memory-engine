/**
 * @memory.build/client — Client library for Memory Engine.
 *
 * Three clients for different use cases:
 *
 * - {@link createClient} — Engine client (API key auth).
 *   The primary client for memory operations, search, user/grant management.
 *
 * - {@link createAccountsClient} — Accounts client (session token auth).
 *   For managing organizations, engines, and invitations. Used by CLI.
 *
 * - {@link createAuthClient} — Auth client (no auth).
 *   OAuth device flow for CLI login. Returns a session token.
 *
 * @example
 * ```ts
 * import { createClient } from "@memory.build/client";
 *
 * const me = createClient({ apiKey: "me.xxx.yyy" });
 *
 * await me.memory.create({
 *   content: "TypeScript was released in 2012",
 *   tree: "knowledge.programming",
 * });
 *
 * const { results } = await me.memory.search({
 *   semantic: "when was TypeScript created",
 * });
 * ```
 */

export type * from "@memory.build/protocol/engine";
export type {
  Meta,
  SearchWeights,
  Temporal,
  TemporalFilter,
} from "@memory.build/protocol/fields";

export type {
  AccountsClient,
  AccountsClientOptions,
  AccountsEngineNamespace,
  InvitationNamespace,
  MeNamespace,
  OrgMemberNamespace,
  OrgNamespace,
  SessionNamespace,
} from "./accounts.ts";
// Accounts client
export { createAccountsClient } from "./accounts.ts";
export type { AuthClient, AuthClientOptions, PollOptions } from "./auth.ts";
// Auth client
export { createAuthClient, DeviceFlowError } from "./auth.ts";
export type {
  ApiKeyNamespace,
  ClientOptions,
  EngineClient,
  GrantNamespace,
  MemoryNamespace,
  OwnerNamespace,
  RoleNamespace,
  UserNamespace,
} from "./engine.ts";
// Engine client (primary)
export { createClient } from "./engine.ts";

// Errors
export { isRpcError, RpcError } from "./errors.ts";
// Version compatibility check
export {
  type CheckServerVersionOptions,
  checkServerVersion,
} from "./version.ts";
