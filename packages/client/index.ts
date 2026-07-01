/**
 * @memory.build/client — Client library for Memory Engine.
 *
 * Two clients, both authenticated by a bearer token:
 *
 * - {@link createMemoryClient} — space data-plane + management.
 *   Talks to /api/v1/memory/rpc with the active space carried as X-Me-Space.
 *   Memory CRUD/search plus principal/group/grant/invite management.
 *
 * - {@link createUserClient} — session-only, user-scoped.
 *   Talks to /api/v1/user/rpc: whoami, agent lifecycle, api keys, space discovery.
 *
 * CLI login is handled out-of-band by the `me` binary (OAuth auth-code + PKCE
 * over a loopback redirect), not by this library.
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
// Reserved thread-link meta keys + canonical memory-path builder (runtime values)
export {
  META_NEXT,
  META_PREV,
  META_THREAD,
  memoryPath,
} from "@memory.build/protocol/meta";

// Errors
export { isRpcError, RpcError } from "./errors.ts";
// Memory client (space data-plane + management)
export {
  createMemoryClient,
  type GrantNamespace,
  type GroupNamespace,
  type InviteNamespace,
  type MemoryClient,
  type MemoryClientOptions,
  type MemoryNamespace,
  type PrincipalNamespace,
} from "./memory.ts";
// User client (session-only: whoami, agent lifecycle, api keys, space discovery)
export {
  type AgentNamespace,
  type ApiKeyNamespace,
  createUserClient,
  type InviteeNamespace,
  type SpaceNamespace,
  type UserClient,
  type UserClientOptions,
} from "./user.ts";
// Version compatibility check
export {
  type CheckServerVersionOptions,
  checkServerVersion,
} from "./version.ts";
