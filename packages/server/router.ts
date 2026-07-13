import { handleBetterAuthRequest } from "./auth/betterauth";
import type { ServerContext } from "./context";
import { healthHandler, readyHandler } from "./handlers/health";
import { versionHandler } from "./handlers/version";
import { authenticateSpace } from "./middleware/authenticate-space";
import { authenticateUser } from "./middleware/authenticate-user";
import { checkClientVersion } from "./middleware/client-version";
import { ensureUserProvisioned } from "./provision";
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
    betterAuth,
    verifyOAuthToken,
    getUserEmailVerified,
    core,
    coreSchema,
    embeddingConfig,
    webDist,
    webAllowedOrigins,
    serverVersion,
    minClientVersion,
  } = ctx;

  // Static web UI (served at root). The bootstrap marks the build as running in
  // hosted mode — `me serve` injects nothing, so it stays in local mode.
  const staticHandler = createStaticHandler({
    webDist,
    bootstrap: { mode: "hosted" },
  });

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
      betterAuth,
      verifyOAuthToken,
      db,
      allowedOrigins: webAllowedOrigins,
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
      principalKind: spaceContext.principalKind,
      ownerId: spaceContext.ownerId,
      apiKeyId: spaceContext.apiKeyId,
      treeAccess: spaceContext.treeAccess,
      admin: spaceContext.admin,
      authenticatedAs: spaceContext.authenticatedAs,
      embeddingConfig,
    };
  });

  // User RPC (new model): account-scoped. Admits any authenticated principal;
  // the handlers authorize per-method (an agent gets whoami / space.list only).
  const userRpcHandler = createRpcHandler(userMethods, async (request) => {
    const result = await authenticateUser(
      request,
      betterAuth,
      verifyOAuthToken,
      getUserEmailVerified,
      core,
      webAllowedOrigins,
    );
    if (!result.ok) {
      return result.error;
    }
    const {
      kind,
      userId,
      email,
      name,
      emailVerified,
      viaApiKey,
      authenticatedAs,
    } = result.context;
    // Lazy first-login provisioning: stand up the core principal the first time
    // a better-auth user reaches the user RPC (idempotent no-op thereafter). The
    // CLI hits whoami/space.list right after login, so this is the natural first
    // touchpoint. NO default space is created here — it's provisioned explicitly
    // via space.ensureDefault at onboarding (so invitees who join don't get a
    // junk space). USERS only — an agent is already provisioned by its owner, and
    // provisioning is user+email keyed (an agent has neither).
    if (kind === "u" && email !== null) {
      await ensureUserProvisioned(
        db,
        core,
        { core: coreSchema },
        {
          userId,
          email,
        },
      );
    }
    return {
      core,
      kind,
      userId,
      email,
      name,
      emailVerified,
      db,
      coreSchema,
      viaApiKey,
      authenticatedAs,
    };
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

    // better-auth owns the entire auth surface under its basePath: social
    // sign-in + OAuth callbacks, sessions/sign-out, and the OAuth 2.1
    // authorize/token endpoints (the CLI's PKCE flow). Mounted as a
    // method-agnostic catch-all so the library routes its own sub-paths.
    {
      method: "*",
      pattern: "/api/v1/auth/*",
      handler: (req) => handleBetterAuthRequest(betterAuth, req),
    },

    // Memory RPC (new model: space data-plane + management)
    {
      method: "POST",
      pattern: "/api/v1/memory/rpc",
      handler: withClientVersionCheck(memoryRpcHandler),
    },

    // User RPC: account, agent, service-account, key, and space management.
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
