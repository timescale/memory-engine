/**
 * @memory.build/client — Client library for Memory Engine.
 *
 * Two clients, both authenticated by a bearer token:
 *
 * - {@link createMemoryClient} — space data-plane + management.
 *   Talks to /api/v1/memory/rpc with the active space carried as X-Me-Space.
 *   Memory CRUD/search plus principal/group/grant/apiKey management.
 *
 * - {@link createUserClient} — session-only, user-scoped.
 *   Talks to /api/v1/user/rpc: whoami, agent lifecycle, space discovery.
 *
 * - {@link createAuthClient} — auth client (no auth).
 *   OAuth device flow for CLI login. Returns a session token.
 *
 * @example
 * ```ts
 * import { createMemoryClient } from "@memory.build/client";
 *
 * const me = createMemoryClient({ token: sessionToken, space: "abc123def456" });
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

export type {
  Meta,
  SearchWeights,
  Temporal,
  TemporalFilter,
} from "@memory.build/protocol/fields";
export type * from "@memory.build/protocol/memory";

export type { AuthClient, AuthClientOptions, PollOptions } from "./auth.ts";
// Auth client
export { createAuthClient, DeviceFlowError } from "./auth.ts";
// Errors
export { isRpcError, RpcError } from "./errors.ts";
// Memory client (space data-plane + management)
export {
  type ApiKeyNamespace,
  createMemoryClient,
  type GrantNamespace,
  type GroupNamespace,
  type InviteNamespace,
  type MemoryClient,
  type MemoryClientOptions,
  type MemoryNamespace,
  type PrincipalNamespace,
} from "./memory.ts";
// User client (session-only: whoami, agent lifecycle, space discovery)
export {
  type AgentNamespace,
  createUserClient,
  type SpaceNamespace,
  type UserClient,
  type UserClientOptions,
} from "./user.ts";
// Version compatibility check
export {
  type CheckServerVersionOptions,
  checkServerVersion,
} from "./version.ts";
