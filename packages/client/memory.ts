/**
 * Memory client — the space data-plane + management client.
 *
 * Talks to POST /api/v1/memory/rpc, authenticated by a session token (human) or
 * an api key (agent), with the active space selected via the X-Me-Space header.
 * Namespaces: memory (data plane) + principal / group / grant / apiKey (management).
 *
 * @example
 * ```ts
 * const me = createMemoryClient({ token: sessionToken, space: "abc123def456" });
 * await me.memory.create({ content: "hello", tree: "notes" });
 * await me.principal.list({});
 * ```
 */

import { SPACE_HEADER } from "@memory.build/protocol/headers";
import type {
  MemoryBatchCreateParams,
  MemoryBatchCreateResult,
  MemoryCountTreeParams,
  MemoryCountTreeResult,
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
} from "@memory.build/protocol/memory";
import type {
  ApiKeyCreateParams,
  ApiKeyCreateResult,
  ApiKeyDeleteParams,
  ApiKeyDeleteResult,
  ApiKeyGetParams,
  ApiKeyGetResult,
  ApiKeyListParams,
  ApiKeyListResult,
  GrantListParams,
  GrantListResult,
  GrantRemoveParams,
  GrantRemoveResult,
  GrantSetParams,
  GrantSetResult,
  GroupAddMemberParams,
  GroupAddMemberResult,
  GroupCreateParams,
  GroupCreateResult,
  GroupDeleteParams,
  GroupDeleteResult,
  GroupListForMemberParams,
  GroupListForMemberResult,
  GroupListMembersParams,
  GroupListMembersResult,
  GroupListParams,
  GroupListResult,
  GroupRemoveMemberParams,
  GroupRemoveMemberResult,
  GroupRenameParams,
  GroupRenameResult,
  InviteCreateParams,
  InviteCreateResult,
  InviteListParams,
  InviteListResult,
  InviteRevokeParams,
  InviteRevokeResult,
  PrincipalAddParams,
  PrincipalAddResult,
  PrincipalListParams,
  PrincipalListResult,
  PrincipalLookupParams,
  PrincipalLookupResult,
  PrincipalRemoveParams,
  PrincipalRemoveResult,
  PrincipalResolveParams,
  PrincipalResolveResult,
} from "@memory.build/protocol/space";
import { rpcCall, type TransportConfig } from "./transport.ts";

export interface MemoryClientOptions {
  /** Base URL of the server (default: "https://api.memory.build") */
  url?: string;
  /** Memory RPC endpoint path (default: "/api/v1/memory/rpc") */
  rpcPath?: string;
  /** Bearer token: a session token (human) or an api key (agent). */
  token?: string;
  /** The active space slug, sent as X-Me-Space. */
  space?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for transient failures (default: 3) */
  retries?: number;
  /** CLIENT_VERSION of the caller (sent as X-Client-Version). */
  clientVersion?: string;
}

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
  countTree(params: MemoryCountTreeParams): Promise<MemoryCountTreeResult>;
}

export interface PrincipalNamespace {
  list(params?: PrincipalListParams): Promise<PrincipalListResult>;
  add(params: PrincipalAddParams): Promise<PrincipalAddResult>;
  remove(params: PrincipalRemoveParams): Promise<PrincipalRemoveResult>;
  /** Resolve principals in the space by name (member-accessible). */
  resolve(params: PrincipalResolveParams): Promise<PrincipalResolveResult>;
  /** Reverse-lookup principal ids → name/kind (member-accessible). */
  lookup(params: PrincipalLookupParams): Promise<PrincipalLookupResult>;
}

export interface GroupNamespace {
  create(params: GroupCreateParams): Promise<GroupCreateResult>;
  list(params?: GroupListParams): Promise<GroupListResult>;
  rename(params: GroupRenameParams): Promise<GroupRenameResult>;
  delete(params: GroupDeleteParams): Promise<GroupDeleteResult>;
  addMember(params: GroupAddMemberParams): Promise<GroupAddMemberResult>;
  removeMember(
    params: GroupRemoveMemberParams,
  ): Promise<GroupRemoveMemberResult>;
  listMembers(params: GroupListMembersParams): Promise<GroupListMembersResult>;
  listForMember(
    params: GroupListForMemberParams,
  ): Promise<GroupListForMemberResult>;
}

export interface GrantNamespace {
  set(params: GrantSetParams): Promise<GrantSetResult>;
  remove(params: GrantRemoveParams): Promise<GrantRemoveResult>;
  list(params?: GrantListParams): Promise<GrantListResult>;
}

export interface InviteNamespace {
  create(params: InviteCreateParams): Promise<InviteCreateResult>;
  list(params?: InviteListParams): Promise<InviteListResult>;
  revoke(params: InviteRevokeParams): Promise<InviteRevokeResult>;
}

export interface ApiKeyNamespace {
  create(params: ApiKeyCreateParams): Promise<ApiKeyCreateResult>;
  list(params: ApiKeyListParams): Promise<ApiKeyListResult>;
  get(params: ApiKeyGetParams): Promise<ApiKeyGetResult>;
  delete(params: ApiKeyDeleteParams): Promise<ApiKeyDeleteResult>;
}

export interface MemoryClient {
  memory: MemoryNamespace;
  principal: PrincipalNamespace;
  group: GroupNamespace;
  grant: GrantNamespace;
  invite: InviteNamespace;
  apiKey: ApiKeyNamespace;

  /** Update the bearer token (session or api key) at runtime. */
  setToken(token: string): void;
  /** Update the active space slug (X-Me-Space) at runtime. */
  setSpace(space: string): void;
}

const DEFAULT_URL = "https://api.memory.build";
const MEMORY_RPC_PATH = "/api/v1/memory/rpc";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

export function createMemoryClient(
  options: MemoryClientOptions = {},
): MemoryClient {
  const config: TransportConfig = {
    url: (options.url ?? DEFAULT_URL).replace(/\/+$/, ""),
    path: options.rpcPath ?? MEMORY_RPC_PATH,
    token: options.token,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
    clientVersion: options.clientVersion,
    headers: options.space ? { [SPACE_HEADER]: options.space } : undefined,
  };

  function rpc<TResult>(method: string, params: unknown): Promise<TResult> {
    return rpcCall<TResult>(config, method, params);
  }

  return {
    memory: {
      create: (p) => rpc("memory.create", p),
      batchCreate: (p) => rpc("memory.batchCreate", p),
      get: (p) => rpc("memory.get", p),
      update: (p) => rpc("memory.update", p),
      delete: (p) => rpc("memory.delete", p),
      search: (p) => rpc("memory.search", p),
      tree: (p) => rpc("memory.tree", p ?? {}),
      move: (p) => rpc("memory.move", p),
      deleteTree: (p) => rpc("memory.deleteTree", p),
      countTree: (p) => rpc("memory.countTree", p),
    },
    principal: {
      list: (p) => rpc("principal.list", p ?? {}),
      add: (p) => rpc("principal.add", p),
      remove: (p) => rpc("principal.remove", p),
      resolve: (p) => rpc("principal.resolve", p),
      lookup: (p) => rpc("principal.lookup", p),
    },
    group: {
      create: (p) => rpc("group.create", p),
      list: (p) => rpc("group.list", p ?? {}),
      rename: (p) => rpc("group.rename", p),
      delete: (p) => rpc("group.delete", p),
      addMember: (p) => rpc("group.addMember", p),
      removeMember: (p) => rpc("group.removeMember", p),
      listMembers: (p) => rpc("group.listMembers", p),
      listForMember: (p) => rpc("group.listForMember", p),
    },
    grant: {
      set: (p) => rpc("grant.set", p),
      remove: (p) => rpc("grant.remove", p),
      list: (p) => rpc("grant.list", p ?? {}),
    },
    invite: {
      create: (p) => rpc("invite.create", p),
      list: (p) => rpc("invite.list", p ?? {}),
      revoke: (p) => rpc("invite.revoke", p),
    },
    apiKey: {
      create: (p) => rpc("apiKey.create", p),
      list: (p) => rpc("apiKey.list", p),
      get: (p) => rpc("apiKey.get", p),
      delete: (p) => rpc("apiKey.delete", p),
    },
    setToken(token: string) {
      config.token = token;
    },
    setSpace(space: string) {
      config.headers = { ...config.headers, [SPACE_HEADER]: space };
    },
  };
}
