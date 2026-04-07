/**
 * Google OAuth provider configuration and helpers.
 *
 * Uses standard OAuth 2.0 authorization code flow for the web portion
 * of the device flow. The device flow itself is handled by our own
 * device-flow.ts module.
 */

import type { OAuthProviderConfig, OAuthUserInfo } from "../types";

/**
 * Google OAuth configuration.
 */
export function getGoogleConfig(): OAuthProviderConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables",
    );
  }

  return {
    provider: "google",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    scopes: ["openid", "email", "profile"],
    clientId,
    clientSecret,
  };
}

/**
 * Build Google OAuth authorization URL.
 *
 * @param state - CSRF protection state parameter
 * @param redirectUri - OAuth callback URL
 */
export function buildGoogleAuthUrl(state: string, redirectUri: string): string {
  const config = getGoogleConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 *
 * @param code - Authorization code from callback
 * @param redirectUri - Same redirect URI used in authorization
 * @returns Access token and optional refresh token
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}> {
  const config = getGoogleConfig();

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token exchange failed: ${error}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch user info from Google.
 *
 * @param accessToken - OAuth access token
 */
export async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<OAuthUserInfo> {
  const config = getGoogleConfig();

  const response = await fetch(config.userinfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch Google user info: ${error}`);
  }

  const data = (await response.json()) as {
    id: string;
    email: string;
    name: string;
    verified_email?: boolean;
  };

  if (!data.email) {
    throw new Error("Google account does not have an email address");
  }

  return {
    providerAccountId: data.id,
    email: data.email,
    name: data.name || data.email.split("@")[0] || "User",
  };
}
