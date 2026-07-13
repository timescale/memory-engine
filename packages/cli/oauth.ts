/**
 * OAuth 2.1 public-client flow for `me login` — authorization-code + PKCE + a
 * loopback redirect (RFC 6749/7636/8252), via the certified `openid-client`
 * library. The loopback server + browser launch live in the login command; this
 * module is the protocol layer (config, PKCE, authorize URL, code/refresh
 * exchange). openid-client handles the audited bits: state + RFC 9207 `iss`
 * validation and token-response checks.
 *
 * Explicit endpoints (no discovery): better-auth advertises issuer =
 * baseURL + basePath (verified against its discovery doc), so we construct the
 * server metadata directly. The CLI is a PUBLIC client (no secret) → None() auth.
 * We omit the `openid` scope (no id_token), so no JWKS is needed — identity is
 * resolved server-side from the access token; offline_access yields the refresh
 * token.
 */
import * as client from "openid-client";

/** The first-party CLI's registered public client_id (seeded in auth migration 006). */
export const OAUTH_CLIENT_ID = "me-cli";

/** offline_access → a refresh token; no `openid` → plain OAuth, no id_token. */
export const OAUTH_SCOPE = "offline_access";

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/** Build an explicit-endpoint Configuration for our better-auth AS. */
function buildConfig(server: string): client.Configuration {
  const issuer = `${server.replace(/\/+$/, "")}/api/v1/auth`;
  const config = new client.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
    },
    OAUTH_CLIENT_ID,
    undefined,
    client.None(), // public client — no secret
  );
  // Local dev servers are http; a real deployment is https.
  if (issuer.startsWith("http://")) client.allowInsecureRequests(config);
  return config;
}

export interface PkcePair {
  /** The secret kept by the CLI and sent at token exchange. */
  verifier: string;
  /** S256(verifier) sent on the authorize request. */
  challenge: string;
}

/** Generate an RFC 7636 PKCE pair (S256). */
export async function generatePkce(): Promise<PkcePair> {
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  return { verifier, challenge };
}

/** Random CSRF state bound to the authorize request, checked on the callback. */
export function generateState(): string {
  return client.randomState();
}

/** Build the `/oauth2/authorize` URL the browser is sent to. */
export function buildAuthorizeUrl(p: {
  server: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /**
   * Optional OIDC `prompt`. `me login --switch` passes `login` to force the
   * authorization server to re-show its sign-in page even when the browser
   * already holds a session — otherwise a trusted client with a live session
   * silently re-issues a code for the signed-in account, so you can never pick
   * a different one. (`select_account` would need a select-account page the AS
   * doesn't configure; `login` reuses the existing `/login` page.)
   */
  prompt?: string;
}): string {
  return client.buildAuthorizationUrl(buildConfig(p.server), {
    redirect_uri: p.redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    state: p.state,
    ...(p.prompt ? { prompt: p.prompt } : {}),
  }).href;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Lifetime of the access token in seconds. */
  expiresIn?: number;
  scope?: string;
}

/**
 * Exchange the authorization-code callback for tokens. `callbackUrl` is the full
 * loopback URL the browser was redirected to (with `code`/`state`/`iss`);
 * openid-client validates `state` + `iss` and runs the PKCE code exchange.
 */
export async function exchangeCode(p: {
  server: string;
  callbackUrl: string;
  codeVerifier: string;
  expectedState: string;
}): Promise<OAuthTokens> {
  try {
    const tokens = await client.authorizationCodeGrant(
      buildConfig(p.server),
      new URL(p.callbackUrl),
      { pkceCodeVerifier: p.codeVerifier, expectedState: p.expectedState },
    );
    return toTokens(tokens);
  } catch (error) {
    throw toOAuthError(error);
  }
}

/** Exchange a refresh token for a fresh access token (public client, no secret). */
export async function refreshTokens(p: {
  server: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  try {
    const tokens = await client.refreshTokenGrant(
      buildConfig(p.server),
      p.refreshToken,
    );
    return toTokens(tokens);
  } catch (error) {
    throw toOAuthError(error);
  }
}

function toTokens(t: client.TokenEndpointResponse): OAuthTokens {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresIn: t.expires_in,
    scope: t.scope,
  };
}

function toOAuthError(error: unknown): OAuthError {
  if (error instanceof OAuthError) return error;
  return new OAuthError(error instanceof Error ? error.message : String(error));
}
