/**
 * User client — session-only, user-scoped operations.
 *
 * Talks to POST /api/v1/user/rpc, authenticated by a session token. Namespaces:
 * agent (a user's global service accounts) and space (discover/create/manage the
 * user's spaces — used by the CLI to pick the active X-Me-Space).
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
  SpaceCreateParams,
  SpaceCreateResult,
  SpaceDeleteParams,
  SpaceDeleteResult,
  SpaceListParams,
  SpaceListResult,
  SpaceRenameParams,
  SpaceRenameResult,
} from "@memory.build/protocol/user";
import { rpcCall, type TransportConfig } from "./transport.ts";

export interface UserClientOptions {
  /** Base URL of the server (default: "https://api.memory.build") */
  url?: string;
  /** User RPC endpoint path (default: "/api/v1/user/rpc") */
  rpcPath?: string;
  /** Session token (humans only). */
  token?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for transient failures (default: 3) */
  retries?: number;
  /** CLIENT_VERSION of the caller (sent as X-Client-Version). */
  clientVersion?: string;
}

export interface AgentNamespace {
  create(params: AgentCreateParams): Promise<AgentCreateResult>;
  list(params?: AgentListParams): Promise<AgentListResult>;
  rename(params: AgentRenameParams): Promise<AgentRenameResult>;
  delete(params: AgentDeleteParams): Promise<AgentDeleteResult>;
}

export interface SpaceNamespace {
  list(params?: SpaceListParams): Promise<SpaceListResult>;
  create(params: SpaceCreateParams): Promise<SpaceCreateResult>;
  rename(params: SpaceRenameParams): Promise<SpaceRenameResult>;
  delete(params: SpaceDeleteParams): Promise<SpaceDeleteResult>;
}

export interface UserClient {
  agent: AgentNamespace;
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
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
    clientVersion: options.clientVersion,
  };

  function rpc<TResult>(method: string, params: unknown): Promise<TResult> {
    return rpcCall<TResult>(config, method, params);
  }

  return {
    agent: {
      create: (p) => rpc("agent.create", p),
      list: (p) => rpc("agent.list", p ?? {}),
      rename: (p) => rpc("agent.rename", p),
      delete: (p) => rpc("agent.delete", p),
    },
    space: {
      list: (p) => rpc("space.list", p ?? {}),
      create: (p) => rpc("space.create", p),
      rename: (p) => rpc("space.rename", p),
      delete: (p) => rpc("space.delete", p),
    },
    setToken(token: string) {
      config.token = token;
    },
  };
}
