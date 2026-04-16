/**
 * Engine client — the primary client for interacting with Memory Engine.
 *
 * Provides typed, namespaced access to all 34 engine RPC methods
 * (memory, user, grant, owner, role, apiKey) authenticated via API key.
 *
 * @example
 * ```ts
 * import { createClient } from "@memory.build/client";
 *
 * const me = createClient({ apiKey: "me.xxx.yyy" });
 *
 * const memory = await me.memory.create({ content: "hello world" });
 * const results = await me.memory.search({ semantic: "hello" });
 * const tree = await me.memory.tree();
 * ```
 */
import type {
  ApiKeyCreateParams,
  ApiKeyCreateResult,
  ApiKeyDeleteParams,
  ApiKeyDeleteResult,
  ApiKeyGetParams,
  ApiKeyListParams,
  ApiKeyListResult,
  ApiKeyResponse,
  ApiKeyRevokeParams,
  ApiKeyRevokeResult,
  EngineMethodName,
  EngineParams,
  EngineResult,
  GrantCheckParams,
  GrantCheckResult,
  GrantCreateParams,
  GrantCreateResult,
  GrantGetParams,
  GrantListParams,
  GrantListResult,
  GrantResponse,
  GrantRevokeParams,
  GrantRevokeResult,
  MemoryBatchCreateParams,
  MemoryBatchCreateResult,
  MemoryCreateParams,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryDeleteTreeParams,
  MemoryDeleteTreeResult,
  MemoryGetParams,
  MemoryMoveParams,
  MemoryMoveResult,
  MemoryResponse,
  MemorySearchParams,
  MemorySearchResult,
  MemoryTreeParams,
  MemoryTreeResult,
  MemoryUpdateParams,
  OwnerGetParams,
  OwnerListParams,
  OwnerListResult,
  OwnerRemoveParams,
  OwnerRemoveResult,
  OwnerResponse,
  OwnerSetParams,
  OwnerSetResult,
  RoleAddMemberParams,
  RoleAddMemberResult,
  RoleCreateParams,
  RoleListForUserParams,
  RoleListForUserResult,
  RoleListMembersParams,
  RoleListMembersResult,
  RoleRemoveMemberParams,
  RoleRemoveMemberResult,
  RoleResponse,
  UserCreateParams,
  UserDeleteParams,
  UserDeleteResult,
  UserGetByNameParams,
  UserGetParams,
  UserListParams,
  UserListResult,
  UserRenameParams,
  UserRenameResult,
  UserResponse,
} from "@memory.build/protocol/engine";
import { rpcCall, type TransportConfig } from "./transport.ts";

// =============================================================================
// Options
// =============================================================================

/**
 * Options for creating an engine client.
 */
export interface ClientOptions {
  /** Base URL of the Memory Engine server (default: "https://api.memory.build") */
  url?: string;
  /** API key for authentication (format: "me.lookupId.secret") */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for transient failures (default: 3) */
  retries?: number;
}

// =============================================================================
// Namespace Types
// =============================================================================

export interface MemoryNamespace {
  create(params: MemoryCreateParams): Promise<MemoryResponse>;
  batchCreate(
    params: MemoryBatchCreateParams,
  ): Promise<MemoryBatchCreateResult>;
  get(params: MemoryGetParams): Promise<MemoryResponse>;
  update(params: MemoryUpdateParams): Promise<MemoryResponse>;
  delete(params: MemoryDeleteParams): Promise<MemoryDeleteResult>;
  search(params: MemorySearchParams): Promise<MemorySearchResult>;
  tree(params?: MemoryTreeParams): Promise<MemoryTreeResult>;
  move(params: MemoryMoveParams): Promise<MemoryMoveResult>;
  deleteTree(params: MemoryDeleteTreeParams): Promise<MemoryDeleteTreeResult>;
}

export interface UserNamespace {
  create(params: UserCreateParams): Promise<UserResponse>;
  get(params: UserGetParams): Promise<UserResponse>;
  getByName(params: UserGetByNameParams): Promise<UserResponse>;
  list(params?: UserListParams): Promise<UserListResult>;
  rename(params: UserRenameParams): Promise<UserRenameResult>;
  delete(params: UserDeleteParams): Promise<UserDeleteResult>;
}

export interface GrantNamespace {
  create(params: GrantCreateParams): Promise<GrantCreateResult>;
  list(params?: GrantListParams): Promise<GrantListResult>;
  get(params: GrantGetParams): Promise<GrantResponse>;
  revoke(params: GrantRevokeParams): Promise<GrantRevokeResult>;
  check(params: GrantCheckParams): Promise<GrantCheckResult>;
}

export interface RoleNamespace {
  create(params: RoleCreateParams): Promise<RoleResponse>;
  addMember(params: RoleAddMemberParams): Promise<RoleAddMemberResult>;
  removeMember(params: RoleRemoveMemberParams): Promise<RoleRemoveMemberResult>;
  listMembers(params: RoleListMembersParams): Promise<RoleListMembersResult>;
  listForUser(params: RoleListForUserParams): Promise<RoleListForUserResult>;
}

export interface OwnerNamespace {
  set(params: OwnerSetParams): Promise<OwnerSetResult>;
  get(params: OwnerGetParams): Promise<OwnerResponse>;
  remove(params: OwnerRemoveParams): Promise<OwnerRemoveResult>;
  list(params?: OwnerListParams): Promise<OwnerListResult>;
}

export interface ApiKeyNamespace {
  create(params: ApiKeyCreateParams): Promise<ApiKeyCreateResult>;
  get(params: ApiKeyGetParams): Promise<ApiKeyResponse>;
  list(params: ApiKeyListParams): Promise<ApiKeyListResult>;
  revoke(params: ApiKeyRevokeParams): Promise<ApiKeyRevokeResult>;
  delete(params: ApiKeyDeleteParams): Promise<ApiKeyDeleteResult>;
}

// =============================================================================
// Client Type
// =============================================================================

/**
 * Memory Engine client.
 */
export interface EngineClient {
  /** Memory operations (create, search, tree, etc.) */
  memory: MemoryNamespace;
  /** User management */
  user: UserNamespace;
  /** Tree grant management */
  grant: GrantNamespace;
  /** Role management */
  role: RoleNamespace;
  /** Tree owner management */
  owner: OwnerNamespace;
  /** API key management */
  apiKey: ApiKeyNamespace;

  /**
   * Low-level typed RPC call.
   * Prefer the namespace methods for convenience.
   */
  call<M extends EngineMethodName>(
    method: M,
    params: EngineParams<M>,
  ): Promise<EngineResult<M>>;

  /** Update the API key at runtime. */
  setApiKey(apiKey: string): void;
  /** Get the current API key. */
  getApiKey(): string | undefined;
}

// =============================================================================
// Factory
// =============================================================================

const DEFAULT_URL = "https://api.memory.build";
const ENGINE_RPC_PATH = "/api/v1/engine/rpc";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

/**
 * Create a Memory Engine client.
 *
 * This is the primary entry point for interacting with Memory Engine.
 * It connects to the engine RPC endpoint using API key authentication.
 *
 * @example
 * ```ts
 * const me = createClient({ apiKey: "me.xxx.yyy" });
 *
 * // Create a memory
 * const memory = await me.memory.create({
 *   content: "TypeScript was released in 2012",
 *   tree: "knowledge.programming",
 * });
 *
 * // Search memories
 * const results = await me.memory.search({
 *   semantic: "when was TypeScript created",
 * });
 * ```
 */
export function createClient(options: ClientOptions = {}): EngineClient {
  const config: TransportConfig = {
    url: (options.url ?? DEFAULT_URL).replace(/\/+$/, ""),
    path: ENGINE_RPC_PATH,
    token: options.apiKey,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
  };

  function call<M extends EngineMethodName>(
    method: M,
    params: EngineParams<M>,
  ): Promise<EngineResult<M>> {
    return rpcCall<EngineResult<M>>(config, method, params);
  }

  const memory: MemoryNamespace = {
    create: (params) => call("memory.create", params),
    batchCreate: (params) => call("memory.batchCreate", params),
    get: (params) => call("memory.get", params),
    update: (params) => call("memory.update", params),
    delete: (params) => call("memory.delete", params),
    search: (params) => call("memory.search", params),
    tree: (params) => call("memory.tree", params ?? {}),
    move: (params) => call("memory.move", params),
    deleteTree: (params) => call("memory.deleteTree", params),
  };

  const user: UserNamespace = {
    create: (params) => call("user.create", params),
    get: (params) => call("user.get", params),
    getByName: (params) => call("user.getByName", params),
    list: (params) => call("user.list", params ?? {}),
    rename: (params) => call("user.rename", params),
    delete: (params) => call("user.delete", params),
  };

  const grant: GrantNamespace = {
    create: (params) => call("grant.create", params),
    list: (params) => call("grant.list", params ?? {}),
    get: (params) => call("grant.get", params),
    revoke: (params) => call("grant.revoke", params),
    check: (params) => call("grant.check", params),
  };

  const role: RoleNamespace = {
    create: (params) => call("role.create", params),
    addMember: (params) => call("role.addMember", params),
    removeMember: (params) => call("role.removeMember", params),
    listMembers: (params) => call("role.listMembers", params),
    listForUser: (params) => call("role.listForUser", params),
  };

  const owner: OwnerNamespace = {
    set: (params) => call("owner.set", params),
    get: (params) => call("owner.get", params),
    remove: (params) => call("owner.remove", params),
    list: (params) => call("owner.list", params ?? {}),
  };

  const apiKey: ApiKeyNamespace = {
    create: (params) => call("apiKey.create", params),
    get: (params) => call("apiKey.get", params),
    list: (params) => call("apiKey.list", params),
    revoke: (params) => call("apiKey.revoke", params),
    delete: (params) => call("apiKey.delete", params),
  };

  return {
    memory,
    user,
    grant,
    role,
    owner,
    apiKey,
    call,
    setApiKey(apiKey: string) {
      config.token = apiKey;
    },
    getApiKey() {
      return config.token;
    },
  };
}
