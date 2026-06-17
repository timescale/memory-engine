import type { ServerContext } from "./context";
import {
  type AuthHandlerContext,
  deviceApproveHandler,
  deviceCodeHandler,
  deviceTokenHandler,
  deviceVerifyGetHandler,
  deviceVerifyPostHandler,
  loginInitiateHandler,
  logoutHandler,
  oauthCallbackHandler,
} from "./handlers/auth";
import { healthHandler, readyHandler } from "./handlers/health";
import { versionHandler } from "./handlers/version";
import { authenticateSpace } from "./middleware/authenticate-space";
import { authenticateUser } from "./middleware/authenticate-user";
import { checkClientVersion } from "./middleware/client-version";
import { createRpcHandler, memoryMethods, userMethods } from "./rpc";
import { methodNotAllowed, notFound } from "./util/response";
import { createStaticHandler } from "./web/static";

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
  const {
    db,
    auth,
    core,
    authSchema,
    coreSchema,
    embeddingConfig,
    apiBaseUrl,
    webDist,
    webAllowedOrigins,
    serverVersion,
    minClientVersion,
  } = ctx;

  // Auth handler context for the device flow + OAuth endpoints
  const authCtx: AuthHandlerContext = {
    auth,
    db,
    authSchema,
    coreSchema,
    baseUrl: apiBaseUrl,
    allowedOrigins: webAllowedOrigins,
  };

  // Static web UI (served at root). The bootstrap marks the build as running in
  // hosted mode — `me serve` injects nothing, so it stays in local mode.
  const staticHandler = createStaticHandler({
    webDist,
    bootstrap: { mode: "hosted" },
  });

  // HTTPS public origin → the secure (`__Host-`) cookie name; drives both
  // cookie minting and the mode-aware cookie read in the auth middlewares.
  const cookieSecure = new URL(apiBaseUrl).protocol === "https:";

  // Wrap an RPC handler with the X-Client-Version check, so requests from
  // too-old clients are rejected before authentication or method dispatch.
  function withClientVersionCheck(
    inner: (request: Request) => Response | Promise<Response>,
  ): (request: Request) => Response | Promise<Response> {
    return (request: Request) => {
      const rejection = checkClientVersion(request, minClientVersion, true);
      if (rejection) {
        return rejection;
      }
      return inner(request);
    };
  }

  // Memory RPC (new model): authenticate principal + space, provide space context
  const memoryRpcHandler = createRpcHandler(memoryMethods, async (request) => {
    const result = await authenticateSpace(request, {
      core,
      auth,
      db,
      allowedOrigins: webAllowedOrigins,
      cookieSecure,
    });
    if (!result.ok) {
      return result.error;
    }
    const spaceContext = result.context;
    return {
      store: spaceContext.store,
      core: spaceContext.core,
      space: spaceContext.space,
      principalId: spaceContext.principalId,
      ownerId: spaceContext.ownerId,
      apiKeyId: spaceContext.apiKeyId,
      treeAccess: spaceContext.treeAccess,
      admin: spaceContext.admin,
      embeddingConfig,
    };
  });

  // User RPC (new model): session-only, user-scoped (agent lifecycle)
  const userRpcHandler = createRpcHandler(userMethods, async (request) => {
    const result = await authenticateUser(
      request,
      auth,
      webAllowedOrigins,
      cookieSecure,
    );
    if (!result.ok) {
      return result.error;
    }
    return { core, auth, userId: result.context.userId, db, coreSchema };
  });

  /**
   * Application routes.
   *
   * Routes are matched in order - more specific routes must come before wildcards.
   */
  const routes: Route[] = [
    // Health checks
    {
      method: "GET",
      pattern: "/health",
      handler: healthHandler,
    },
    {
      method: "GET",
      pattern: "/ready",
      handler: readyHandler(db),
    },

    // Version compatibility check (unauthenticated)
    {
      method: "GET",
      pattern: "/api/v1/version",
      handler: versionHandler(serverVersion, minClientVersion),
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

    // OAuth Device Flow - User approves/denies after OAuth (consent step)
    {
      method: "POST",
      pattern: "/api/v1/auth/device/approve",
      handler: (req) => deviceApproveHandler(req, authCtx),
    },

    // OAuth Callback - Provider redirects here after user authorizes
    {
      method: "GET",
      pattern: "/api/v1/auth/callback/:provider",
      handler: (req, params) => oauthCallbackHandler(req, params, authCtx),
    },

    // Browser (hosted-UI) login - start OAuth, set a session cookie on callback
    {
      method: "GET",
      pattern: "/api/v1/auth/login/:provider",
      handler: (req, params) => loginInitiateHandler(req, params, authCtx),
    },

    // Browser (hosted-UI) logout - clear the session cookie
    {
      method: "POST",
      pattern: "/api/v1/auth/logout",
      handler: (req) => logoutHandler(req, authCtx),
    },

    // Memory RPC (new model: space data-plane + management)
    {
      method: "POST",
      pattern: "/api/v1/memory/rpc",
      handler: withClientVersionCheck(memoryRpcHandler),
    },

    // User RPC (new model: session-only, user-scoped agent lifecycle)
    {
      method: "POST",
      pattern: "/api/v1/user/rpc",
      handler: withClientVersionCheck(userRpcHandler),
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
   * When no API route matches, an unknown `/api/*` path returns a JSON 404
   * (never the SPA), and any other GET/HEAD is served by the static web UI
   * (asset, else `index.html` for client-side routing). Other methods on a
   * non-API path are a 405.
   */
  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = matchRoute(request.method, url.pathname);

    if (match) {
      return match.route.handler(request, match.params);
    }

    if (url.pathname.startsWith("/api/")) {
      return notFound();
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return staticHandler.handle(request, url.pathname);
    }

    return methodNotAllowed(["GET", "HEAD"]);
  }

  return { handleRequest, matchRoute };
}

// Re-export for backward compatibility with tests
export { matchPath as _matchPath };
