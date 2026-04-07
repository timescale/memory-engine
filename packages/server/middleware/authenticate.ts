/**
 * Authentication context types.
 * Will be populated by auth middleware.
 */

/**
 * Identity from accounts DB (for accounts RPC).
 */
export interface Identity {
  id: string;
  email: string;
  name: string | null;
}

/**
 * User from engine DB (for engine RPC).
 */
export interface User {
  id: string;
  name: string;
  superuser: boolean;
  createrole: boolean;
  canLogin: boolean;
}

/**
 * Auth context for accounts RPC requests.
 */
export interface AccountsAuthContext {
  type: "accounts";
  identity: Identity;
}

/**
 * Auth context for engine RPC requests.
 */
export interface EngineAuthContext {
  type: "engine";
  slug: string;
  user: User;
}

/**
 * Union type for all auth contexts.
 */
export type AuthContext = AccountsAuthContext | EngineAuthContext;

/**
 * Result of authentication attempt.
 */
export type AuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; error: Response };

/**
 * Stub: Authenticate request for accounts RPC.
 * Will validate session token and return identity.
 *
 * TODO: Implement in chunk 6
 */
export async function authenticateAccounts(
  _request: Request,
): Promise<AuthResult> {
  // Stub - will be implemented when we add accounts RPC
  return {
    ok: false,
    error: new Response("Not Implemented", { status: 501 }),
  };
}

/**
 * Stub: Authenticate request for engine RPC.
 * Will parse API key, extract slug, validate against engine DB.
 *
 * TODO: Implement in chunk 5
 */
export async function authenticateEngine(
  _request: Request,
): Promise<AuthResult> {
  // Stub - will be implemented when we add API key auth
  return {
    ok: false,
    error: new Response("Not Implemented", { status: 501 }),
  };
}
