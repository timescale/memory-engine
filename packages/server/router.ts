import { healthHandler } from "./handlers/health";
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
 * Stub handler for unimplemented routes.
 */
function notImplementedHandler(_request: Request): Response {
  return new Response(
    JSON.stringify({
      error: { message: "Not Implemented", code: "NOT_IMPLEMENTED" },
    }),
    { status: 501, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * RPC handlers.
 */
const accountsRpcHandler = createRpcHandler(accountsMethods);
const engineRpcHandler = createRpcHandler(engineMethods);

/**
 * Application routes.
 */
const routes: Route[] = [
  // Health check
  {
    method: "GET",
    pattern: "/health",
    handler: healthHandler,
  },

  // OAuth endpoints (to be implemented in chunk 7)
  {
    method: "*",
    pattern: "/api/v1/auth/*",
    handler: notImplementedHandler,
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
export function matchRoute(method: string, path: string): RouteMatch | null {
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
export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = matchRoute(request.method, url.pathname);

  if (!match) {
    return notFound();
  }

  return match.route.handler(request, match.params);
}
