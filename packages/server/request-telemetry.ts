/**
 * Attributes added to the root inbound HTTP span. OAuth token grants are public
 * client requests, so record their caller-provided process diagnostics here:
 * Better Auth's handler span has no authenticated principal to attach them to.
 *
 * The token endpoint is UNAUTHENTICATED — anyone can hit it — so caller-supplied
 * headers are treated as untrusted input. Each is length- and shape-bounded
 * (our own CLI user-agent, a UUID instance id, one of the fixed mode strings)
 * before recording. The instance ID is intentionally high-cardinality per
 * process for race attribution; this validation does not authenticate callers.
 */
import { type Counter, metrics, type UpDownCounter } from "@opentelemetry/api";
import { oauthErrorTelemetryAttributes } from "./auth/oauth-errors";
import { readTelemetryBody } from "./auth/oauth-request-metadata";
import { jsonResponseTelemetry } from "./util/response";

const TOKEN_ENDPOINT_PATH = "/api/v1/auth/oauth2/token";

/** Telemetry failures must never change a request's business outcome. */
export function setTelemetryAttributes(
  target: {
    setAttribute(key: string, value: string | number | boolean): unknown;
  },
  attributes: Record<string, string | number | boolean>,
): void {
  try {
    for (const [key, value] of Object.entries(attributes)) {
      target.setAttribute(key, value);
    }
  } catch {
    // Best effort.
  }
}

/** These are fixed route buckets, never raw paths, RPC names or identities. */
export function httpMetricLabels(request: Request): Record<string, string> {
  const path = new URL(request.url).pathname;
  const route =
    path === "/api/v1/memory/rpc" ||
    path === "/api/v1/user/rpc" ||
    path === TOKEN_ENDPOINT_PATH
      ? path
      : path.startsWith("/api/v1/auth/")
        ? "/api/v1/auth/*"
        : path.startsWith("/api/")
          ? "/api/*"
          : "web";
  const method = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ].includes(request.method)
    ? request.method
    : "OTHER";
  return { "http.route": route, "http.request.method": method };
}

export function httpResponseTelemetryAttributes(
  response: Response,
): Record<string, string | number> {
  return {
    "http.response.status_code": response.status,
    "http.outcome":
      response.status >= 500
        ? "server_error"
        : response.status >= 400
          ? "client_error"
          : "success",
    ...jsonResponseTelemetry(response),
  };
}

let activeRequests: UpDownCounter | undefined;
let completedRequests: Counter | undefined;

/**
 * In-flight means handler lifetime, NOT socket lifetime/network flush. Both
 * success and thrown failures release the count in finally. No request labels
 * at all on the UpDownCounter; completion labels are a fixed vocabulary.
 */
export async function observeHttpRequest(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  let counted = false;
  try {
    const meter = metrics.getMeter("memory-engine.http");
    activeRequests ??= meter.createUpDownCounter(
      "memory_engine.http.requests.active",
      {
        unit: "{request}",
        description: "Inbound HTTP handlers active (not network flush)",
      },
    );
    activeRequests.add(1);
    counted = true;
  } catch {
    // Instrument setup/recording is fail-open.
  }
  let response: Response | undefined;
  try {
    response = await handler();
    return response;
  } finally {
    try {
      if (counted) activeRequests?.add(-1);
    } catch {
      // Best effort; keep cleanup independent of completion recording.
    }
    try {
      completedRequests ??= metrics
        .getMeter("memory-engine.http")
        .createCounter("memory_engine.http.requests.completed", {
          unit: "{request}",
        });
      completedRequests.add(1, {
        ...httpMetricLabels(request),
        "http.response.status_code": response?.status ?? 500,
        "http.outcome": response
          ? response.status >= 500
            ? "server_error"
            : response.status >= 400
              ? "client_error"
              : "success"
          : "exception",
      });
    } catch {
      // Best effort.
    }
  }
}
const MAX_USER_AGENT_LENGTH = 256;
const MAX_INSTANCE_LENGTH = 128;
const MAX_MODE_LENGTH = 32;

/** Matches the CLI's own user-agent (see packages/cli/oauth.ts `buildConfig`). */
const CLI_USER_AGENT_RE = /^memory-engine-cli\/[\w.+-]+$/;
/** UUID v4/v7/etc. (any RFC 4122 variant); matches `crypto.randomUUID()`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_MODES = new Set(["cli", "mcp", "serve"]);

function validatedUserAgent(request: Request): string | undefined {
  const value = request.headers.get("user-agent");
  if (!value || value.length > MAX_USER_AGENT_LENGTH) return undefined;
  return CLI_USER_AGENT_RE.test(value) ? value : undefined;
}

function validatedInstanceId(request: Request): string | undefined {
  const value = request.headers.get("x-me-client-instance");
  if (!value || value.length > MAX_INSTANCE_LENGTH) return undefined;
  return UUID_RE.test(value) ? value : undefined;
}

function validatedMode(request: Request): string | undefined {
  const value = request.headers.get("x-me-client-mode");
  if (!value || value.length > MAX_MODE_LENGTH) return undefined;
  return VALID_MODES.has(value) ? value : undefined;
}

export function httpRequestTelemetryAttributes(
  request: Request,
): Record<string, string> {
  const path = new URL(request.url).pathname;
  const attributes: Record<string, string> = {
    "http.method": request.method,
    // OAuth credentials belong in the POST body, but never copy unexpected
    // token-endpoint query parameters into telemetry either.
    "http.url":
      path === TOKEN_ENDPOINT_PATH
        ? `${new URL(request.url).origin}${path}`
        : request.url,
    "http.path": path,
  };
  if (path !== TOKEN_ENDPOINT_PATH) return attributes;

  const userAgent = validatedUserAgent(request);
  const instance = validatedInstanceId(request);
  const mode = validatedMode(request);
  if (userAgent) attributes["client.user_agent"] = userAgent;
  if (instance) attributes["client.instance.id"] = instance;
  if (mode) attributes["client.mode"] = mode;
  return attributes;
}

/**
 * Classify the root token span using fixed outcomes and rejection reasons.
 * The matching nested Better Auth APIError is normalized by the OAuth span
 * processor. Neither path logs raw error descriptions or credential payloads.
 */
export async function tokenResponseTelemetryAttributes(
  request: Request,
  response: Response,
): Promise<Record<string, string | boolean>> {
  if (new URL(request.url).pathname !== TOKEN_ENDPOINT_PATH) return {};

  const attributes: Record<string, string | boolean> = {
    "oauth.grant.http_status": String(response.status),
  };
  if (response.ok) {
    attributes["oauth.grant.outcome"] = "success";
    return attributes;
  }
  try {
    const text = await readTelemetryBody(response);
    if (text === undefined) return attributes;
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const { error, error_description } = body as Record<string, unknown>;
      if (typeof error === "string")
        Object.assign(
          attributes,
          oauthErrorTelemetryAttributes(
            response.status,
            error,
            error_description,
          ),
        );
    }
  } catch {
    // A non-JSON error response has no OAuth error code to classify.
  }
  return attributes;
}
