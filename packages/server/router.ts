import type { ServerContext } from "./context";
import {
  type AuthHandlerContext,
  deviceCodeHandler,
  deviceTokenHandler,
  deviceVerifyGetHandler,
  deviceVerifyPostHandler,
  oauthCallbackHandler,
} from "./handlers/auth";
import { healthHandler } from "./handlers/health";
import {
  authenticateAccounts,
  authenticateEngine,
} from "./middleware/authenticate";
import { accountsMethods, createRpcHandler, engineMethods } from "./rpc";
import { notFound } from "./util/response";

/**
 * Route definition.
 */
export interface Route {
  /** HTTP method (GET, POST, etc.) or "*" for any */
  method: string;
  /** URL path pattern */
  pattern: string;
  /** Handler function */
  handler: (
    request: Request,
    params: RouteParams,
  ) => Response | Promise<Response>;
}

/**
 * Matched route parameters.
 */
export interface RouteParams {
  /** Named path parameters (e.g., :provider -> "google") */
  [key: string]: string;
}

/**
 * Result of route matching.
 */
export interface RouteMatch {
  route: Route;
  params: RouteParams;
}

/**
 * Match a URL path against a pattern.
 * Supports:
 * - Exact match: "/health"
 * - Named params: "/api/v1/auth/callback/:provider"
 * - Wildcard suffix: "/api/v1/auth/*"
 *
 * @returns params object if matched, null if no match
 */
function matchPath(pattern: string, path: string): RouteParams | null {
  // Exact match
  if (pattern === path) {
    return {};
  }

  // Wildcard suffix match
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return { "*": path.slice(prefix.length + 1) };
    }
    return null;
  }

  // Parameter matching
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: RouteParams = {};

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];

    if (patternPart === undefined || pathPart === undefined) {
      return null;
    }

    if (patternPart.startsWith(":")) {
      // Named parameter
      params[patternPart.slice(1)] = pathPart;
    } else if (patternPart !== pathPart) {
      // Literal mismatch
      return null;
    }
  }

  return params;
}

/**
 * Router result from createRouter.
 */
export interface Router {
  /** Handle an incoming request */
  handleRequest: (request: Request) => Promise<Response>;
  /** Match a route (for testing) */
  matchRoute: (method: string, path: string) => RouteMatch | null;
}

/**
 * Create a router with injected database connections.
 *
 * @param ctx - Server context with database pools
 * @returns Router with handleRequest function
 */
export function createRouter(ctx: ServerContext): Router {
  const { accountsDb, engineSql, embeddingConfig, apiBaseUrl } = ctx;

  // Auth handler context for device flow endpoints
  const authCtx: AuthHandlerContext = {
    db: accountsDb,
    baseUrl: apiBaseUrl,
  };

  // Engine RPC: authenticate and provide db context
  const engineRpcHandler = createRpcHandler(engineMethods, async (request) => {
    const auth = await authenticateEngine(request, accountsDb, engineSql);
    if (!auth.ok) {
      return auth.error;
    }
    // TypeScript narrows auth.context to AuthContext after ok check
    // We know it's EngineAuthContext since we called authenticateEngine
    const ctx = auth.context;
    if (ctx.type !== "engine") {
      throw new Error("Unexpected auth context type");
    }
    return {
      db: ctx.db,
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId,
      engine: ctx.engine,
      embeddingConfig,
    };
  });

  // Accounts RPC: authenticate and provide identity context
  const accountsRpcHandler = createRpcHandler(
    accountsMethods,
    async (request) => {
      const auth = await authenticateAccounts(request, accountsDb);
      if (!auth.ok) {
        return auth.error;
      }
      // TypeScript narrows auth.context to AuthContext after ok check
      // We know it's AccountsAuthContext since we called authenticateAccounts
      const ctx = auth.context;
      if (ctx.type !== "accounts") {
        throw new Error("Unexpected auth context type");
      }
      return {
        db: accountsDb,
        identityId: ctx.identity.id,
        identity: ctx.identity,
      };
    },
  );

  /**
   * Application routes.
   *
   * Routes are matched in order - more specific routes must come before wildcards.
   */
  const routes: Route[] = [
    // Health check
    {
      method: "GET",
      pattern: "/health",
      handler: healthHandler,
    },

    // OAuth Device Flow - CLI initiates
    {
      method: "POST",
      pattern: "/api/v1/auth/device/code",
      handler: (req) => deviceCodeHandler(req, authCtx),
    },

    // OAuth Device Flow - CLI polls for token
    {
      method: "POST",
      pattern: "/api/v1/auth/device/token",
      handler: (req) => deviceTokenHandler(req, authCtx),
    },

    // OAuth Device Flow - User enters code (GET = form, POST = submit)
    {
      method: "GET",
      pattern: "/api/v1/auth/device/verify",
      handler: (req) => deviceVerifyGetHandler(req, authCtx),
    },
    {
      method: "POST",
      pattern: "/api/v1/auth/device/verify",
      handler: (req) => deviceVerifyPostHandler(req, authCtx),
    },

    // OAuth Callback - Provider redirects here after user authorizes
    {
      method: "GET",
      pattern: "/api/v1/auth/callback/:provider",
      handler: (req, params) => oauthCallbackHandler(req, params, authCtx),
    },

    // Accounts RPC
    {
      method: "POST",
      pattern: "/api/v1/accounts/rpc",
      handler: accountsRpcHandler,
    },

    // Engine RPC
    {
      method: "POST",
      pattern: "/api/v1/engine/rpc",
      handler: engineRpcHandler,
    },
  ];

  /**
   * Match a request to a route.
   *
   * @returns RouteMatch if found, null if no matching route
   */
  function matchRoute(method: string, path: string): RouteMatch | null {
    for (const route of routes) {
      // Check method
      if (route.method !== "*" && route.method !== method) {
        continue;
      }

      // Check path
      const params = matchPath(route.pattern, path);
      if (params !== null) {
        return { route, params };
      }
    }

    return null;
  }

  /**
   * Handle a request by matching it to a route and executing the handler.
   *
   * @returns Response from handler or 404 if no route matches
   */
  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = matchRoute(request.method, url.pathname);

    if (!match) {
      return notFound();
    }

    return match.route.handler(request, match.params);
  }

  return { handleRequest, matchRoute };
}

// Re-export for backward compatibility with tests
export { matchPath as _matchPath };
