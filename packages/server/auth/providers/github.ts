/**
 * GitHub OAuth provider configuration and helpers.
 *
 * Uses standard OAuth 2.0 authorization code flow for the web portion
 * of the device flow. The device flow itself is handled by our own
 * device-flow.ts module.
 *
 * GitHub OAuth docs: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 */

import type { OAuthProviderConfig, OAuthUserInfo } from "../types";

/**
 * GitHub OAuth configuration.
 */
export function getGitHubConfig(): OAuthProviderConfig {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET environment variables",
    );
  }

  return {
    provider: "github",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    // GitHub scopes: read:user for profile, user:email for email addresses
    scopes: ["read:user", "user:email"],
    clientId,
    clientSecret,
  };
}

/**
 * Build GitHub OAuth authorization URL.
 *
 * @param state - CSRF protection state parameter
 * @param redirectUri - OAuth callback URL
 */
export function buildGitHubAuthUrl(state: string, redirectUri: string): string {
  const config = getGitHubConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
  });

  return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 *
 * @param code - Authorization code from callback
 * @param redirectUri - Same redirect URI used in authorization
 * @returns Access token (GitHub doesn't provide refresh tokens for OAuth apps)
 */
export async function exchangeGitHubCode(
  code: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}> {
  const config = getGitHubConfig();

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub token exchange failed: ${error}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(
      `GitHub token exchange failed: ${data.error_description || data.error}`,
    );
  }

  if (!data.access_token) {
    throw new Error("GitHub token exchange failed: no access token returned");
  }

  return {
    accessToken: data.access_token,
    // GitHub OAuth apps don't provide refresh tokens
    // (GitHub Apps do, but we're using OAuth Apps for simplicity)
    refreshToken: null,
    // GitHub tokens don't expire unless revoked
    expiresIn: 0,
  };
}

/**
 * Fetch user info from GitHub.
 *
 * @param accessToken - OAuth access token
 */
export async function fetchGitHubUserInfo(
  accessToken: string,
): Promise<OAuthUserInfo> {
  const config = getGitHubConfig();

  // Fetch user profile
  const userResponse = await fetch(config.userinfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!userResponse.ok) {
    const error = await userResponse.text();
    throw new Error(`Failed to fetch GitHub user info: ${error}`);
  }

  const userData = (await userResponse.json()) as {
    id: number;
    login: string;
    name: string | null;
  };

  // Always resolve the email via /user/emails so we get its `verified` flag
  // (the public profile email field carries no verification signal).
  const primary = await fetchGitHubPrimaryEmail(accessToken);
  if (!primary) {
    throw new Error(
      "GitHub account does not have an email address. Please add one in your GitHub settings.",
    );
  }

  return {
    providerAccountId: String(userData.id),
    email: primary.email,
    emailVerified: primary.verified,
    name: userData.name || userData.login,
  };
}

/**
 * Fetch the user's primary email from GitHub, with its verified flag.
 * (Returns the primary email if present, else the first; null if none.)
 */
async function fetchGitHubPrimaryEmail(
  accessToken: string,
): Promise<{ email: string; verified: boolean } | null> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    return null;
  }

  const emails = (await response.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;

  const chosen = emails.find((e) => e.primary) ?? emails[0];
  return chosen ? { email: chosen.email, verified: chosen.verified } : null;
}
