import { span } from "@pydantic/logfire-node";
import type { ZodError } from "zod";
import { json } from "../util/response";
import { mapDbTimeoutError } from "./db-errors";
import {
  type AppError,
  applicationError,
  internalError,
  invalidParams,
  invalidRequest,
  isAppError,
  isExpectedAppError,
  methodNotFound,
  parseError,
} from "./errors";
import { getMethod } from "./registry";
import type {
  HandlerContext,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  MethodRegistry,
} from "./types";

/**
 * Validate that a parsed object is a valid JSON-RPC 2.0 request.
 */
function validateEnvelope(
  obj: unknown,
): { ok: true; request: JsonRpcRequest } | { ok: false; error: string } {
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, error: "request must be an object" };
  }

  const req = obj as Record<string, unknown>;

  if (req.jsonrpc !== "2.0") {
    return { ok: false, error: 'jsonrpc must be "2.0"' };
  }

  if (typeof req.method !== "string") {
    return { ok: false, error: "method must be a string" };
  }

  if (req.id === undefined || req.id === null) {
    return { ok: false, error: "id is required" };
  }

  if (typeof req.id !== "string" && typeof req.id !== "number") {
    return { ok: false, error: "id must be a string or number" };
  }

  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      method: req.method,
      params: req.params,
      id: req.id,
    },
  };
}

function appErrorResponse(error: unknown, requestId: string | number | null) {
  const appErr = mapDbTimeoutError(error) ?? (isAppError(error) ? error : null);
  if (!appErr) return null;

  return json(
    applicationError(
      requestId,
      appErr.code,
      appErr.message,
      appErr.details as Record<string, unknown> | undefined,
    ),
  );
}

/**
 * Format Zod validation errors into a readable string.
 */
function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
  return issues.join("; ");
}

/**
 * Create a success response.
 */
function createSuccessResponse(
  result: unknown,
  id: string | number,
): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    result,
    id,
  };
}

/**
 * Handle a JSON-RPC request.
 *
 * @param request - The HTTP request
 * @param registry - The method registry to dispatch to
 * @param context - Additional context to pass to handlers
 * @returns HTTP Response with JSON-RPC result
 */
export async function handleRpcRequest(
  request: Request,
  registry: MethodRegistry,
  context: Partial<HandlerContext> = {},
): Promise<Response> {
  let requestId: string | number | null = null;

  try {
    // Parse JSON body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(parseError());
    }

    // Validate JSON-RPC envelope
    const validation = validateEnvelope(body);
    if (!validation.ok) {
      return json(invalidRequest(null, validation.error));
    }

    const rpcRequest = validation.request;
    requestId = rpcRequest.id;

    // Look up method
    const method = getMethod(registry, rpcRequest.method);
    if (!method) {
      return json(methodNotFound(rpcRequest.method, requestId));
    }

    const handlerContext: HandlerContext = { request, ...context };

    // Authorize before validating params: a caller that may not invoke this
    // method shouldn't have its input parsed — it gets a consistent
    // authorization error rather than an INVALID_PARAMS that leaks the param
    // schema. Throws an AppError on denial (mapped below).
    method.authorize?.(handlerContext);

    // Validate params
    const paramsResult = method.schema.safeParse(rpcRequest.params);
    if (!paramsResult.success) {
      return json(invalidParams(requestId, formatZodError(paramsResult.error)));
    }

    // Build identity attributes from auth context
    const identityAttrs: Record<string, string> = {};
    const ctx = context as Record<string, unknown>;
    if (ctx.engine && typeof ctx.engine === "object") {
      const engine = ctx.engine as {
        id?: string;
        orgId?: string;
        slug?: string;
      };
      if (engine.id) identityAttrs["engine.id"] = engine.id;
      if (engine.orgId) identityAttrs["org.id"] = engine.orgId;
      if (engine.slug) identityAttrs["engine.slug"] = engine.slug;
    }
    if (typeof ctx.userId === "string") identityAttrs["user.id"] = ctx.userId;
    if (typeof ctx.apiKeyId === "string")
      identityAttrs["api_key.id"] = ctx.apiKeyId;
    // When a human is acting as one of their own agents (X-Me-As-Agent), record
    // the human separately for observability. Never gates authorization.
    if (typeof ctx.authenticatedAs === "string")
      identityAttrs.authenticated_as = ctx.authenticatedAs;
    if (ctx.identity && typeof ctx.identity === "object") {
      const identity = ctx.identity as { id?: string };
      if (identity.id) identityAttrs["identity.id"] = identity.id;
    }

    // Execute the handler in a span. Expected business / validation /
    // authorization errors (NOT_FOUND, FORBIDDEN, CONFLICT, …) are caught
    // *inside* the callback so they never propagate as a throw — that keeps the
    // span helper from recording them as exceptions (they're normal outcomes,
    // not failures). They're tagged on the span so they stay queryable, then
    // surfaced out-of-band and mapped to the same JSON-RPC error response below.
    // Genuine failures (including DB timeouts) still throw and are recorded by
    // the span helper as exceptions.
    const outcome = await span(`rpc.${rpcRequest.method}`, {
      attributes: {
        "rpc.method": rpcRequest.method,
        "rpc.request_id": String(requestId),
        ...identityAttrs,
      },
      callback: async (
        activeSpan,
      ): Promise<
        { ok: true; value: unknown } | { ok: false; error: AppError }
      > => {
        try {
          const value = await method.handler(paramsResult.data, handlerContext);
          return { ok: true, value };
        } catch (err) {
          if (isExpectedAppError(err)) {
            activeSpan.setAttribute("rpc.outcome", "business_error");
            activeSpan.setAttribute("rpc.error_code", err.code);
            activeSpan.setAttribute("error.expected", true);
            return { ok: false, error: err };
          }
          throw err;
        }
      },
    });

    if (!outcome.ok) {
      // Expected business error: already tagged on the span (not an exception).
      return (
        appErrorResponse(outcome.error, requestId) ??
        json(internalError(requestId))
      );
    }

    return json(createSuccessResponse(outcome.value, requestId ?? 0));
  } catch (error: unknown) {
    const response = appErrorResponse(error, requestId ?? 0);
    if (response) return response;

    // Error already recorded on rpc.* span by the span helper
    return json(internalError(requestId));
  }
}

/**
 * Create an RPC request handler bound to a specific registry.
 *
 * @param registry - The method registry
 * @param contextProvider - Optional function to provide additional context.
 *   Can return a Response directly to short-circuit (e.g., for auth failures).
 * @returns Request handler function
 */
export function createRpcHandler(
  registry: MethodRegistry,
  contextProvider?: (
    request: Request,
  ) =>
    | Partial<HandlerContext>
    | Response
    | Promise<Partial<HandlerContext> | Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      if (contextProvider) {
        const result = await contextProvider(request);
        // If contextProvider returns a Response, return it directly (auth failure)
        if (result instanceof Response) {
          return result;
        }
        return handleRpcRequest(request, registry, result);
      }
      return handleRpcRequest(request, registry, {});
    } catch (error) {
      const response = appErrorResponse(error, null);
      if (response) return response;
      return json(internalError(null));
    }
  };
}
