/**
 * Accounts client — for managing organizations, engines, and invitations.
 *
 * Authenticated via session token (obtained from the device flow login).
 * Typically used by the CLI, not by end-user applications.
 *
 * @example
 * ```ts
 * import { createAccountsClient } from "@memory-engine/client";
 *
 * const accounts = createAccountsClient({ sessionToken: "..." });
 *
 * const identity = await accounts.me.get();
 * const orgs = await accounts.org.list();
 * ```
 */
import type {
  AccountsMethodName,
  AccountsParams,
  AccountsResult,
  EngineCreateParams,
  EngineDeleteParams,
  EngineDeleteResult,
  EngineGetParams,
  EngineListParams,
  EngineListResult,
  EngineResponse,
  EngineSetupAccessParams,
  EngineSetupAccessResult,
  EngineUpdateParams,
  IdentityGetByEmailParams,
  IdentityGetByEmailResult,
  IdentityResponse,
  InvitationAcceptParams,
  InvitationAcceptResult,
  InvitationCreateParams,
  InvitationCreateResult,
  InvitationListParams,
  InvitationListResult,
  InvitationRevokeParams,
  InvitationRevokeResult,
  OrgCreateParams,
  OrgDeleteParams,
  OrgDeleteResult,
  OrgGetParams,
  OrgListResult,
  OrgMemberAddParams,
  OrgMemberListParams,
  OrgMemberListResult,
  OrgMemberRemoveParams,
  OrgMemberRemoveResult,
  OrgMemberResponse,
  OrgMemberUpdateRoleParams,
  OrgMemberUpdateRoleResult,
  OrgResponse,
  OrgUpdateParams,
  SessionRevokeResult,
} from "@memory-engine/protocol/accounts";
import { rpcCall, type TransportConfig } from "./transport.ts";

// =============================================================================
// Options
// =============================================================================

/**
 * Options for creating an accounts client.
 */
export interface AccountsClientOptions {
  /** Base URL of the Memory Engine server (default: "https://api.memory.build") */
  url?: string;
  /** Session token for authentication */
  sessionToken?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts for transient failures (default: 3) */
  retries?: number;
}

// =============================================================================
// Namespace Types
// =============================================================================

export interface MeNamespace {
  get(): Promise<IdentityResponse>;
}

export interface IdentityNamespace {
  getByEmail(
    params: IdentityGetByEmailParams,
  ): Promise<IdentityGetByEmailResult>;
}

export interface SessionNamespace {
  revoke(): Promise<SessionRevokeResult>;
}

export interface OrgNamespace {
  create(params: OrgCreateParams): Promise<OrgResponse>;
  list(): Promise<OrgListResult>;
  get(params: OrgGetParams): Promise<OrgResponse>;
  update(params: OrgUpdateParams): Promise<OrgResponse>;
  delete(params: OrgDeleteParams): Promise<OrgDeleteResult>;
  member: OrgMemberNamespace;
}

export interface OrgMemberNamespace {
  list(params: OrgMemberListParams): Promise<OrgMemberListResult>;
  add(params: OrgMemberAddParams): Promise<OrgMemberResponse>;
  remove(params: OrgMemberRemoveParams): Promise<OrgMemberRemoveResult>;
  updateRole(
    params: OrgMemberUpdateRoleParams,
  ): Promise<OrgMemberUpdateRoleResult>;
}

export interface AccountsEngineNamespace {
  create(params: EngineCreateParams): Promise<EngineResponse>;
  list(params: EngineListParams): Promise<EngineListResult>;
  get(params: EngineGetParams): Promise<EngineResponse>;
  update(params: EngineUpdateParams): Promise<EngineResponse>;
  delete(params: EngineDeleteParams): Promise<EngineDeleteResult>;
  setupAccess(
    params: EngineSetupAccessParams,
  ): Promise<EngineSetupAccessResult>;
}

export interface InvitationNamespace {
  create(params: InvitationCreateParams): Promise<InvitationCreateResult>;
  list(params: InvitationListParams): Promise<InvitationListResult>;
  revoke(params: InvitationRevokeParams): Promise<InvitationRevokeResult>;
  accept(params: InvitationAcceptParams): Promise<InvitationAcceptResult>;
}

// =============================================================================
// Client Type
// =============================================================================

/**
 * Accounts client.
 */
export interface AccountsClient {
  /** Current identity */
  me: MeNamespace;
  /** Identity lookup */
  identity: IdentityNamespace;
  /** Session management */
  session: SessionNamespace;
  /** Organization management */
  org: OrgNamespace;
  /** Engine management */
  engine: AccountsEngineNamespace;
  /** Invitation management */
  invitation: InvitationNamespace;

  /**
   * Low-level typed RPC call.
   * Prefer the namespace methods for convenience.
   */
  call<M extends AccountsMethodName>(
    method: M,
    params: AccountsParams<M>,
  ): Promise<AccountsResult<M>>;

  /** Update the session token at runtime. */
  setSessionToken(token: string): void;
  /** Get the current session token. */
  getSessionToken(): string | undefined;
}

// =============================================================================
// Factory
// =============================================================================

const DEFAULT_URL = "https://api.memory.build";
const ACCOUNTS_RPC_PATH = "/api/v1/accounts/rpc";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

/**
 * Create an accounts client.
 *
 * Used for managing organizations, engines, members, and invitations.
 * Requires a session token obtained from the device flow login.
 *
 * @example
 * ```ts
 * const accounts = createAccountsClient({ sessionToken: "..." });
 *
 * const identity = await accounts.me.get();
 * const { orgs } = await accounts.org.list();
 * ```
 */
export function createAccountsClient(
  options: AccountsClientOptions = {},
): AccountsClient {
  const config: TransportConfig = {
    url: (options.url ?? DEFAULT_URL).replace(/\/+$/, ""),
    path: ACCOUNTS_RPC_PATH,
    token: options.sessionToken,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
  };

  function call<M extends AccountsMethodName>(
    method: M,
    params: AccountsParams<M>,
  ): Promise<AccountsResult<M>> {
    return rpcCall<AccountsResult<M>>(config, method, params);
  }

  const member: OrgMemberNamespace = {
    list: (params) => call("org.member.list", params),
    add: (params) => call("org.member.add", params),
    remove: (params) => call("org.member.remove", params),
    updateRole: (params) => call("org.member.updateRole", params),
  };

  const me: MeNamespace = {
    get: () => call("me.get", {}),
  };

  const identity: IdentityNamespace = {
    getByEmail: (params) => call("identity.getByEmail", params),
  };

  const session: SessionNamespace = {
    revoke: () => call("session.revoke", {}),
  };

  const org: OrgNamespace = {
    create: (params) => call("org.create", params),
    list: () => call("org.list", {}),
    get: (params) => call("org.get", params),
    update: (params) => call("org.update", params),
    delete: (params) => call("org.delete", params),
    member,
  };

  const engine: AccountsEngineNamespace = {
    create: (params) => call("engine.create", params),
    list: (params) => call("engine.list", params),
    get: (params) => call("engine.get", params),
    update: (params) => call("engine.update", params),
    delete: (params) => call("engine.delete", params),
    setupAccess: (params) => call("engine.setupAccess", params),
  };

  const invitation: InvitationNamespace = {
    create: (params) => call("invitation.create", params),
    list: (params) => call("invitation.list", params),
    revoke: (params) => call("invitation.revoke", params),
    accept: (params) => call("invitation.accept", params),
  };

  return {
    me,
    identity,
    session,
    org,
    engine,
    invitation,
    call,
    setSessionToken(token: string) {
      config.token = token;
    },
    getSessionToken() {
      return config.token;
    },
  };
}
