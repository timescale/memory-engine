/**
 * User client — session-only, user-scoped operations.
 *
 * Talks to POST /api/v1/user/rpc, authenticated by a session token. Namespaces:
 * agent (a user's global service accounts), apiKey (those agents' global keys),
 * and space (discover/create/manage the user's spaces — used by the CLI to pick
 * the active X-Me-Space).
 */
import type {
  AgentCreateParams,
  AgentCreateResult,
  AgentDeleteParams,
  AgentDeleteResult,
  AgentListParams,
  AgentListResult,
  AgentRenameParams,
  AgentRenameResult,
  AgentSpacesParams,
  AgentSpacesResult,
  ApiKeyCreateParams,
  ApiKeyCreateResult,
  ApiKeyDeleteParams,
  ApiKeyDeleteResult,
  ApiKeyGetParams,
  ApiKeyGetResult,
  ApiKeyListParams,
  ApiKeyListResult,
  SpaceCreateParams,
  SpaceCreateResult,
  SpaceDeleteParams,
  SpaceDeleteResult,
  SpaceListParams,
  SpaceListResult,
  SpaceRenameParams,
  SpaceRenameResult,
  WhoamiParams,
  WhoamiResult,
} from "@memory.build/protocol/user";
import { rpcCall, type TransportConfig } from "./transport.ts";

export interface UserClientOptions {
  /** Base URL of the server (default: "https://api.memory.build") */
  url?: string;
  /** User RPC endpoint path (default: "/api/v1/user/rpc") */
  rpcPath?: string;
  /** Session token (humans only). */
  token?: string;
  /**
   * Async bearer provider (overrides `token`); resolved per call, refreshing an
   * OAuth access token by expiry. See {@link TransportConfig.getToken}.
   */
  getToken?: () => Promise<string | undefined>;
  /** Reactive refresh hook fired on a 401. See {@link TransportConfig.onUnauthorized}. */
  onUnauthorized?: () => Promise<string | undefined>;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for read-only calls. Mutating calls are not retried. */
  retries?: number;
  /** CLIENT_VERSION of the caller (sent as X-Client-Version). */
  clientVersion?: string;
}

export interface AgentNamespace {
  create(params: AgentCreateParams): Promise<AgentCreateResult>;
  list(params?: AgentListParams): Promise<AgentListResult>;
  spaces(params: AgentSpacesParams): Promise<AgentSpacesResult>;
  rename(params: AgentRenameParams): Promise<AgentRenameResult>;
  delete(params: AgentDeleteParams): Promise<AgentDeleteResult>;
}

export interface ApiKeyNamespace {
  create(params: ApiKeyCreateParams): Promise<ApiKeyCreateResult>;
  list(params: ApiKeyListParams): Promise<ApiKeyListResult>;
  get(params: ApiKeyGetParams): Promise<ApiKeyGetResult>;
  delete(params: ApiKeyDeleteParams): Promise<ApiKeyDeleteResult>;
}

export interface SpaceNamespace {
  list(params?: SpaceListParams): Promise<SpaceListResult>;
  create(params: SpaceCreateParams): Promise<SpaceCreateResult>;
  rename(params: SpaceRenameParams): Promise<SpaceRenameResult>;
  delete(params: SpaceDeleteParams): Promise<SpaceDeleteResult>;
}

export interface UserClient {
  /** The identity behind the session token. */
  whoami(params?: WhoamiParams): Promise<WhoamiResult>;
  agent: AgentNamespace;
  apiKey: ApiKeyNamespace;
  space: SpaceNamespace;
  /** Update the session token at runtime. */
  setToken(token: string): void;
}

const DEFAULT_URL = "https://api.memory.build";
const USER_RPC_PATH = "/api/v1/user/rpc";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

export function createUserClient(options: UserClientOptions = {}): UserClient {
  const config: TransportConfig = {
    url: (options.url ?? DEFAULT_URL).replace(/\/+$/, ""),
    path: options.rpcPath ?? USER_RPC_PATH,
    token: options.token,
    getToken: options.getToken,
    onUnauthorized: options.onUnauthorized,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
    clientVersion: options.clientVersion,
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

  return {
    whoami: (p) => readRpc("whoami", p ?? {}),
    agent: {
      create: (p) => writeRpc("agent.create", p),
      list: (p) => readRpc("agent.list", p ?? {}),
      spaces: (p) => readRpc("agent.spaces", p),
      rename: (p) => writeRpc("agent.rename", p),
      delete: (p) => writeRpc("agent.delete", p),
    },
    apiKey: {
      create: (p) => writeRpc("apiKey.create", p),
      list: (p) => readRpc("apiKey.list", p),
      get: (p) => readRpc("apiKey.get", p),
      delete: (p) => writeRpc("apiKey.delete", p),
    },
    space: {
      list: (p) => readRpc("space.list", p ?? {}),
      create: (p) => writeRpc("space.create", p),
      rename: (p) => writeRpc("space.rename", p),
      delete: (p) => writeRpc("space.delete", p),
    },
    setToken(token: string) {
      config.token = token;
    },
  };
}
