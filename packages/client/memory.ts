/**
 * Memory client — the space data-plane + management client.
 *
 * Talks to POST /api/v1/memory/rpc, authenticated by a session token (human) or
 * an api key (agent), with the active space selected via the X-Me-Space header.
 * Namespaces: memory (data plane) + principal / group / grant / invite (management).
 * (Agent lifecycle and api keys live on the user client.)
 *
 * @example
 * ```ts
 * const me = createMemoryClient({ token: sessionToken, space: "abc123def456" });
 * await me.memory.create({ content: "hello", tree: "notes" });
 * await me.principal.list({});
 * ```
 */

import { AS_AGENT_HEADER, SPACE_HEADER } from "@memory.build/protocol/headers";
import type {
  MemoryAppendParams,
  MemoryAppendResult,
  MemoryBatchCreateParams,
  MemoryBatchCreateResult,
  MemoryCopyParams,
  MemoryCopyResult,
  MemoryCountTreeParams,
  MemoryCountTreeResult,
  MemoryCreateParams,
  MemoryDeleteByPathParams,
  MemoryDeleteOrphansInTreeParams,
  MemoryDeleteOrphansInTreeResult,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryDeleteTreeParams,
  MemoryDeleteTreeResult,
  MemoryEmbeddingStatusResult,
  MemoryGetByPathParams,
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
  GroupSetIsSpaceAdminParams,
  GroupSetIsSpaceAdminResult,
  InviteCreateParams,
  InviteCreateResult,
  InviteListParams,
  InviteListResult,
  InviteRevokeByIdParams,
  InviteRevokeByIdResult,
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
import { assertConcreteAsAgent } from "./as-agent";
import { rpcCall, type TransportConfig } from "./transport.ts";

export interface MemoryClientOptions {
  /** Base URL of the server (default: "https://api.memory.build") */
  url?: string;
  /** Memory RPC endpoint path (default: "/api/v1/memory/rpc") */
  rpcPath?: string;
  /** Bearer token: a session token (human) or an api key (agent). */
  token?: string;
  /**
   * Async bearer provider (overrides `token`); resolved per call, refreshing an
   * OAuth access token by expiry. See {@link TransportConfig.getToken}.
   */
  getToken?: () => Promise<string | undefined>;
  /** Reactive refresh hook fired on a 401. See {@link TransportConfig.onUnauthorized}. */
  onUnauthorized?: () => Promise<string | undefined>;
  /** The active space slug, sent as X-Me-Space. */
  space?: string;
  /**
   * Act as one of the caller's own agents — an agent id or name, sent as
   * X-Me-As-Agent. A human credential (session / OAuth / user PAT) is then
   * authorized as that agent, constrained exactly as the agent's own api key.
   * Ignored server-side when the bearer is itself an agent api key.
   */
  asAgent?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for read-only calls. Mutating calls are not retried. */
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
  getByPath(params: MemoryGetByPathParams): Promise<MemoryResponse>;
  update(params: MemoryUpdateParams): Promise<MemoryResponse>;
  /**
   * Append text to a memory's content. Unlike other mutations this call is
   * transport-retried: its operation-scoped `idempotencyKey` makes a retry
   * replay rather than double-append, so a dropped response is safe.
   */
  append(params: MemoryAppendParams): Promise<MemoryAppendResult>;
  delete(params: MemoryDeleteParams): Promise<MemoryDeleteResult>;
  deleteByPath(params: MemoryDeleteByPathParams): Promise<MemoryDeleteResult>;
  search(params: MemorySearchParams): Promise<MemorySearchResult>;
  tree(params?: MemoryTreeParams): Promise<MemoryTreeResult>;
  copy(params: MemoryCopyParams): Promise<MemoryCopyResult>;
  move(params: MemoryMoveParams): Promise<MemoryMoveResult>;
  deleteTree(params: MemoryDeleteTreeParams): Promise<MemoryDeleteTreeResult>;
  deleteOrphansInTree(
    params: MemoryDeleteOrphansInTreeParams,
  ): Promise<MemoryDeleteOrphansInTreeResult>;
  countTree(params: MemoryCountTreeParams): Promise<MemoryCountTreeResult>;
  /** Space-wide embedding backlog snapshot (pending/failed/…). */
  embeddingStatus(): Promise<MemoryEmbeddingStatusResult>;
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
  setIsSpaceAdmin(
    params: GroupSetIsSpaceAdminParams,
  ): Promise<GroupSetIsSpaceAdminResult>;
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
  revokeById(params: InviteRevokeByIdParams): Promise<InviteRevokeByIdResult>;
}

export interface MemoryClient {
  memory: MemoryNamespace;
  principal: PrincipalNamespace;
  group: GroupNamespace;
  grant: GrantNamespace;
  invite: InviteNamespace;

  /** Update the bearer token (session or api key) at runtime. */
  setToken(token: string): void;
  /** Update the active space slug (X-Me-Space) at runtime. */
  setSpace(space: string): void;
  /**
   * Update the act-as-agent target (X-Me-As-Agent) at runtime. An empty string
   * clears the header (act as the human credential).
   */
  setAsAgent(asAgent: string): void;
}

const DEFAULT_URL = "https://api.memory.build";
const MEMORY_RPC_PATH = "/api/v1/memory/rpc";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

/** Seed the initial header map from the space + act-as-agent options. */
function seedHeaders(
  options: MemoryClientOptions,
): Record<string, string> | undefined {
  assertConcreteAsAgent(options.asAgent);
  const headers: Record<string, string> = {};
  if (options.space) headers[SPACE_HEADER] = options.space;
  if (options.asAgent) headers[AS_AGENT_HEADER] = options.asAgent;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function createMemoryClient(
  options: MemoryClientOptions = {},
): MemoryClient {
  const config: TransportConfig = {
    url: (options.url ?? DEFAULT_URL).replace(/\/+$/, ""),
    path: options.rpcPath ?? MEMORY_RPC_PATH,
    token: options.token,
    getToken: options.getToken,
    onUnauthorized: options.onUnauthorized,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
    clientVersion: options.clientVersion,
    headers: seedHeaders(options),
  };

  function readRpc<TResult>(method: string, params: unknown): Promise<TResult> {
    return rpcCall<TResult>(config, method, params);
  }

  function writeRpc<TResult>(
    method: string,
    params: unknown,
  ): Promise<TResult> {
    return rpcCall<TResult>(config, method, params, { retries: 0 });
  }

  // memory.append is the one mutation that is safe to transport-retry: it
  // carries an operation-scoped idempotency key, so the server replays the
  // original result on a retry instead of appending twice. Ordinary mutations
  // stay on writeRpc (retries: 0).
  function retryableWriteRpc<TResult>(
    method: string,
    params: unknown,
  ): Promise<TResult> {
    return rpcCall<TResult>(config, method, params);
  }

  return {
    memory: {
      create: (p) => writeRpc("memory.create", p),
      batchCreate: (p) => writeRpc("memory.batchCreate", p),
      get: (p) => readRpc("memory.get", p),
      getByPath: (p) => readRpc("memory.getByPath", p),
      update: (p) => writeRpc("memory.update", p),
      append: (p) => retryableWriteRpc("memory.append", p),
      delete: (p) => writeRpc("memory.delete", p),
      deleteByPath: (p) => writeRpc("memory.deleteByPath", p),
      search: (p) => readRpc("memory.search", p),
      tree: (p) => readRpc("memory.tree", p ?? {}),
      copy: (p) => writeRpc("memory.copy", p),
      move: (p) => writeRpc("memory.move", p),
      deleteTree: (p) => writeRpc("memory.deleteTree", p),
      deleteOrphansInTree: (p) => writeRpc("memory.deleteOrphansInTree", p),
      countTree: (p) => readRpc("memory.countTree", p),
      embeddingStatus: () => readRpc("memory.embeddingStatus", {}),
    },
    principal: {
      list: (p) => readRpc("principal.list", p ?? {}),
      add: (p) => writeRpc("principal.add", p),
      remove: (p) => writeRpc("principal.remove", p),
      resolve: (p) => readRpc("principal.resolve", p),
      lookup: (p) => readRpc("principal.lookup", p),
    },
    group: {
      create: (p) => writeRpc("group.create", p),
      list: (p) => readRpc("group.list", p ?? {}),
      rename: (p) => writeRpc("group.rename", p),
      delete: (p) => writeRpc("group.delete", p),
      setIsSpaceAdmin: (p) => writeRpc("group.setIsSpaceAdmin", p),
      addMember: (p) => writeRpc("group.addMember", p),
      removeMember: (p) => writeRpc("group.removeMember", p),
      listMembers: (p) => readRpc("group.listMembers", p),
      listForMember: (p) => readRpc("group.listForMember", p),
    },
    grant: {
      set: (p) => writeRpc("grant.set", p),
      remove: (p) => writeRpc("grant.remove", p),
      list: (p) => readRpc("grant.list", p ?? {}),
    },
    invite: {
      create: (p) => writeRpc("invite.create", p),
      list: (p) => readRpc("invite.list", p ?? {}),
      revoke: (p) => writeRpc("invite.revoke", p),
      revokeById: (p) => writeRpc("invite.revokeById", p),
    },
    setToken(token: string) {
      config.token = token;
    },
    setSpace(space: string) {
      config.headers = { ...config.headers, [SPACE_HEADER]: space };
    },
    setAsAgent(asAgent: string) {
      assertConcreteAsAgent(asAgent);
      const headers = { ...config.headers };
      if (asAgent) headers[AS_AGENT_HEADER] = asAgent;
      else delete headers[AS_AGENT_HEADER];
      config.headers = headers;
    },
  };
}
