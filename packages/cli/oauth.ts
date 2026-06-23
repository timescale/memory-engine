/**
 * OAuth 2.1 public-client primitives for `me login` — authorization-code + PKCE
 * (RFC 6749 / 7636 / 8252). The CLI is a public client (no secret); PKCE binds
 * the code to this device. The loopback server + browser launch live in the
 * login command; this module is the pure protocol layer (PKCE, the authorize
 * URL, and the token/refresh exchanges), so it's unit-testable on its own.
 */
import { createHash, randomBytes } from "node:crypto";

/** Endpoints are under better-auth's basePath (see AUTH_BASE_PATH server-side). */
const OAUTH_BASE = "/api/v1/auth/oauth2";

/** The first-party CLI's registered public client_id (seeded in auth migration 006). */
export const OAUTH_CLIENT_ID = "me-cli";

/** Scopes: openid/profile/email for identity, offline_access for a refresh token. */
export const OAUTH_SCOPE = "openid profile email offline_access";

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface PkcePair {
  /** The secret kept by the CLI and sent at token exchange. */
  verifier: string;
  /** S256(verifier) sent on the authorize request. */
  challenge: string;
}

/** Generate an RFC 7636 PKCE pair (base64url, S256). */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url"); // 43-char unreserved
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Random CSRF state bound to the authorize request and checked on the callback. */
export function generateState(): string {
  return randomBytes(16).toString("base64url");
}

export interface AuthorizeUrlParams {
  server: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

/** Build the `/oauth2/authorize` URL the browser is sent to. */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL(`${trimSlash(p.server)}${OAUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", p.state);
  url.searchParams.set("scope", OAUTH_SCOPE);
  return url.toString();
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Lifetime of the access token in seconds. */
  expiresIn?: number;
  scope?: string;
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export function exchangeCode(p: {
  server: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OAuthTokens> {
  return tokenRequest(
    p.server,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: p.codeVerifier,
    }),
  );
}

/** Exchange a refresh token for a fresh access token (public client, no secret). */
export function refreshTokens(p: {
  server: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  return tokenRequest(
    p.server,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: p.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  );
}

async function tokenRequest(
  server: string,
  body: URLSearchParams,
): Promise<OAuthTokens> {
  let response: Response;
  try {
    response = await fetch(`${trimSlash(server)}${OAUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    throw new OAuthError(
      `Token request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    throw new OAuthError(
      json.error_description ??
        json.error ??
        `Token request: HTTP ${response.status}`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
