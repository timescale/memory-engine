/**
 * Attributes added to the root inbound HTTP span. OAuth token grants are public
 * client requests, so record their caller-provided process diagnostics here:
 * Better Auth's handler span has no authenticated principal to attach them to.
 *
 * The token endpoint is UNAUTHENTICATED — anyone can hit it — so caller-supplied
 * headers are treated as untrusted input. Each is validated against a known
 * shape (our own CLI user-agent, a UUID instance id, one of the fixed mode
 * strings) so an attacker can't inflate root-span cardinality by spraying
 * random values on `client.instance.id` / `client.mode` / `client.user_agent`.
 */
const TOKEN_ENDPOINT_PATH = "/api/v1/auth/oauth2/token";
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
    "http.url": request.url,
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
