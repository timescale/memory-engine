import type { AccountsDB } from "@memory-engine/accounts";
import {
  createEngineDB,
  type EngineDB,
  parseApiKey,
} from "@memory-engine/engine";
import type { SQL } from "bun";
import { forbidden, unauthorized } from "../util/response";

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
 * Engine info from accounts DB.
 */
export interface EngineInfo {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "deleted";
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
  db: EngineDB;
  userId: string;
  apiKeyId: string;
  engine: EngineInfo;
}

/**
 * Factory function type for creating EngineDB instances.
 * Allows dependency injection for testing.
 */
export type CreateEngineDBFn = (sql: SQL, schema: string) => EngineDB;

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
 * Authenticate request for engine RPC.
 * Parses API key, looks up engine, validates key against engine DB.
 */
export async function authenticateEngine(
  request: Request,
  accountsDb: AccountsDB,
  engineSql: SQL,
  createEngineDBFn: CreateEngineDBFn = createEngineDB,
): Promise<AuthResult> {
  // 1. Extract bearer token
  const token = extractBearerToken(request);
  if (!token) {
    return {
      ok: false,
      error: unauthorized("Missing or invalid Authorization header"),
    };
  }

  // 2. Parse API key
  const parsed = parseApiKey(token);
  if (!parsed) {
    return { ok: false, error: unauthorized("Invalid API key format") };
  }

  const { engineSlug, lookupId, secret } = parsed;

  // 3. Look up engine in accounts DB
  const engine = await accountsDb.getEngineBySlug(engineSlug);
  if (!engine) {
    return { ok: false, error: unauthorized("Engine not found") };
  }

  // 4. Check engine status
  if (engine.status !== "active") {
    return {
      ok: false,
      error: forbidden(`Engine is ${engine.status}`),
    };
  }

  // 5. Create EngineDB for this engine's schema
  const db = createEngineDBFn(engineSql, `me_${engineSlug}`);

  // 6. Validate API key
  const validation = await db.validateApiKey(lookupId, secret);
  if (!validation.valid || !validation.userId || !validation.apiKeyId) {
    return { ok: false, error: unauthorized("Invalid or expired API key") };
  }

  // 7. Set user on db for RLS context
  db.setUser(validation.userId);

  // 8. Build engine info
  const engineInfo: EngineInfo = {
    id: engine.id,
    orgId: engine.orgId,
    slug: engine.slug,
    name: engine.name,
    status: engine.status,
  };

  return {
    ok: true,
    context: {
      type: "engine",
      db,
      userId: validation.userId,
      apiKeyId: validation.apiKeyId,
      engine: engineInfo,
    },
  };
}
