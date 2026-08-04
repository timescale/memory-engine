/**
 * Attributes added to the root inbound HTTP span. OAuth token grants are public
 * client requests, so record their caller-provided process diagnostics here:
 * Better Auth's handler span has no authenticated principal to attach them to.
 */
const TOKEN_ENDPOINT_PATH = "/api/v1/auth/oauth2/token";
const MAX_USER_AGENT_LENGTH = 256;
const MAX_INSTANCE_LENGTH = 128;
const MAX_MODE_LENGTH = 32;

function boundedHeader(
  request: Request,
  name: string,
  maxLength: number,
): string | undefined {
  const value = request.headers.get(name);
  return value && value.length <= maxLength ? value : undefined;
}

export function httpRequestTelemetryAttributes(
  request: Request,
): Record<string, string> {
  const path = new URL(request.url).pathname;
  const attributes: Record<string, string> = {
    "http.method": request.method,
    "http.url": request.url,
    "http.path": path,
  };
  if (path !== TOKEN_ENDPOINT_PATH) return attributes;

  const userAgent = boundedHeader(request, "user-agent", MAX_USER_AGENT_LENGTH);
  const instance = boundedHeader(
    request,
    "x-me-client-instance",
    MAX_INSTANCE_LENGTH,
  );
  const mode = boundedHeader(request, "x-me-client-mode", MAX_MODE_LENGTH);
  if (userAgent) attributes["client.user_agent"] = userAgent;
  if (instance) attributes["client.instance.id"] = instance;
  if (mode) attributes["client.mode"] = mode;
  return attributes;
}

/**
 * Classify OAuth token-endpoint responses on the root HTTP span. Better Auth
 * owns the nested handler span and records its thrown APIError, but this lets
 * dashboards/alerts distinguish expected client-side `invalid_grant` outcomes
 * from server failures without consuming the response body.
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
    const body = (await response.clone().json()) as { error?: unknown };
    if (typeof body.error === "string") {
      attributes["oauth.grant.outcome"] = body.error;
      if (body.error === "invalid_grant") attributes["error.expected"] = true;
    }
  } catch {
    // A non-JSON error response has no OAuth error code to classify.
  }
  return attributes;
}
