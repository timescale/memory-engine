/**
 * OAuth provider registry.
 */

import type {
  OAuthProvider,
  OAuthProviderConfig,
  OAuthUserInfo,
} from "../types";
import {
  buildGitHubAuthUrl,
  exchangeGitHubCode,
  fetchGitHubUserInfo,
  getGitHubConfig,
} from "./github";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  getGoogleConfig,
} from "./google";

/**
 * Get provider configuration.
 */
export function getProviderConfig(
  provider: OAuthProvider,
): OAuthProviderConfig {
  switch (provider) {
    case "google":
      return getGoogleConfig();
    case "github":
      return getGitHubConfig();
    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }
}

/**
 * Build authorization URL for provider.
 */
export function buildAuthUrl(
  provider: OAuthProvider,
  state: string,
  redirectUri: string,
): string {
  switch (provider) {
    case "google":
      return buildGoogleAuthUrl(state, redirectUri);
    case "github":
      return buildGitHubAuthUrl(state, redirectUri);
    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}> {
  switch (provider) {
    case "google":
      return exchangeGoogleCode(code, redirectUri);
    case "github":
      return exchangeGitHubCode(code, redirectUri);
    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }
}

/**
 * Fetch user info from provider.
 */
export async function fetchUserInfo(
  provider: OAuthProvider,
  accessToken: string,
): Promise<OAuthUserInfo> {
  switch (provider) {
    case "google":
      return fetchGoogleUserInfo(accessToken);
    case "github":
      return fetchGitHubUserInfo(accessToken);
    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }
}
