/**
 * User client — user/account and service-account operations.
 *
 * Talks to POST /api/v1/user/rpc, authenticated by a session/OAuth token or the
 * user's own PAT for management operations. Namespaces: serviceAccount
 * (space-scoped integration identities), apiKey (keys for credential-bearing
 * principals), and space (discover/create/manage the user's spaces — used by
 * the CLI to pick the active X-Me-Space).
 */

import type {
  ApiKeyCreateParams,
  ApiKeyCreateResult,
  ApiKeyDeleteParams,
  ApiKeyDeleteResult,
  ApiKeyGetParams,
  ApiKeyGetResult,
  ApiKeyListParams,
  ApiKeyListResult,
  InviteAcceptParams,
  InviteAcceptResult,
  InviteDeclineParams,
  InviteDeclineResult,
  InvitePendingParams,
  InvitePendingResult,
  InviteRedeemParams,
  InviteRedeemResult,
  ServiceAccountCreateParams,
  ServiceAccountCreateResult,
  ServiceAccountDeleteParams,
  ServiceAccountDeleteResult,
  ServiceAccountListParams,
  ServiceAccountListResult,
  ServiceAccountRenameParams,
  ServiceAccountRenameResult,
  SpaceCreateParams,
  SpaceCreateResult,
  SpaceDeleteParams,
  SpaceDeleteResult,
  SpaceEnsureDefaultParams,
  SpaceEnsureDefaultResult,
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

export interface ServiceAccountNamespace {
  create(
    params: ServiceAccountCreateParams,
  ): Promise<ServiceAccountCreateResult>;
  list(params: ServiceAccountListParams): Promise<ServiceAccountListResult>;
  rename(
    params: ServiceAccountRenameParams,
  ): Promise<ServiceAccountRenameResult>;
  delete(
    params: ServiceAccountDeleteParams,
  ): Promise<ServiceAccountDeleteResult>;
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
  ensureDefault(
    params?: SpaceEnsureDefaultParams,
  ): Promise<SpaceEnsureDefaultResult>;
  rename(params: SpaceRenameParams): Promise<SpaceRenameResult>;
  delete(params: SpaceDeleteParams): Promise<SpaceDeleteResult>;
}

/** Invitee-side invitation operations (invitations addressed to the caller). */
export interface InviteeNamespace {
  pending(params?: InvitePendingParams): Promise<InvitePendingResult>;
  accept(params: InviteAcceptParams): Promise<InviteAcceptResult>;
  decline(params: InviteDeclineParams): Promise<InviteDeclineResult>;
  /** Redeem a magic-link token (open link, or an email-matched link). */
  redeem(params: InviteRedeemParams): Promise<InviteRedeemResult>;
}

export interface UserClient {
  /** The identity behind the session token. */
  whoami(params?: WhoamiParams): Promise<WhoamiResult>;
  serviceAccount: ServiceAccountNamespace;
  apiKey: ApiKeyNamespace;
  space: SpaceNamespace;
  invite: InviteeNamespace;
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
    serviceAccount: {
      create: (p) => writeRpc("serviceAccount.create", p),
      list: (p) => readRpc("serviceAccount.list", p),
      rename: (p) => writeRpc("serviceAccount.rename", p),
      delete: (p) => writeRpc("serviceAccount.delete", p),
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
      ensureDefault: (p) => writeRpc("space.ensureDefault", p ?? {}),
      rename: (p) => writeRpc("space.rename", p),
      delete: (p) => writeRpc("space.delete", p),
    },
    invite: {
      pending: (p) => readRpc("invite.pending", p ?? {}),
      accept: (p) => writeRpc("invite.accept", p),
      decline: (p) => writeRpc("invite.decline", p),
      redeem: (p) => writeRpc("invite.redeem", p),
    },
    setToken(token: string) {
      config.token = token;
    },
  };
}
