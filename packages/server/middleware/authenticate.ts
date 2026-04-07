import type { AccountsDB } from "@memory-engine/accounts";
import { unauthorized } from "../util/response";

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
 * Extract Bearer token from Authorization header.
 * Returns null if header is missing, malformed, or not Bearer auth.
 */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  const token = parts[1];
  if (!token || token.length === 0) {
    return null;
  }

  return token;
}

/**
 * Authenticate request for accounts RPC.
 * Validates session token and returns identity.
 */
export async function authenticateAccounts(
  request: Request,
  accountsDb: AccountsDB,
): Promise<AuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      ok: false,
      error: unauthorized("Missing or invalid Authorization header"),
    };
  }

  const sessionResult = await accountsDb.validateSession(token);
  if (!sessionResult) {
    return {
      ok: false,
      error: unauthorized("Invalid or expired session"),
    };
  }

  return {
    ok: true,
    context: {
      type: "accounts",
      identity: {
        id: sessionResult.identity.id,
        email: sessionResult.identity.email,
        name: sessionResult.identity.name,
      },
    },
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
