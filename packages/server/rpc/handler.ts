import { span } from "@pydantic/logfire-node";
import type { ZodError } from "zod";
import { json } from "../util/response";
import {
  applicationError,
  internalError,
  invalidParams,
  invalidRequest,
  isAppError,
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

    // Validate params
    const paramsResult = method.schema.safeParse(rpcRequest.params);
    if (!paramsResult.success) {
      return json(invalidParams(requestId, formatZodError(paramsResult.error)));
    }

    // Execute handler in a span
    const result = await span(`rpc.${rpcRequest.method}`, {
      attributes: {
        "rpc.method": rpcRequest.method,
        "rpc.request_id": String(requestId),
      },
      callback: async () => {
        const handlerContext: HandlerContext = {
          request,
          ...context,
        };
        return method.handler(paramsResult.data, handlerContext);
      },
    });

    return json(createSuccessResponse(result, requestId ?? 0));
  } catch (error: unknown) {
    // Handle application errors (thrown by handlers)
    if (isAppError(error)) {
      const appErr = error as {
        code: string;
        message: string;
        details?: unknown;
      };
      return json(
        applicationError(
          requestId ?? 0,
          appErr.code,
          appErr.message,
          appErr.details as Record<string, unknown> | undefined,
        ),
      );
    }

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
    if (contextProvider) {
      const result = await contextProvider(request);
      // If contextProvider returns a Response, return it directly (auth failure)
      if (result instanceof Response) {
        return result;
      }
      return handleRpcRequest(request, registry, result);
    }
    return handleRpcRequest(request, registry, {});
  };
}
