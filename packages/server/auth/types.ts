/**
 * OAuth device flow types.
 *
 * Implements RFC 8628 (OAuth 2.0 Device Authorization Grant) for
 * Google and GitHub providers.
 */

/**
 * Supported OAuth providers.
 */
export type OAuthProvider = "google" | "github";

/**
 * Device authorization request (from CLI).
 */
export interface DeviceCodeRequest {
  provider: OAuthProvider;
}

/**
 * Device authorization response (to CLI).
 */
export interface DeviceCodeResponse {
  /** Unique device identifier for polling */
  deviceCode: string;
  /** Code the user enters in the browser */
  userCode: string;
  /** URL where user enters the code */
  verificationUri: string;
  /** How long the codes are valid (seconds) */
  expiresIn: number;
  /** How often CLI should poll (seconds) */
  interval: number;
}

/**
 * Token poll request (from CLI).
 */
export interface DeviceTokenRequest {
  deviceCode: string;
}

/**
 * Token poll response (to CLI).
 */
export interface DeviceTokenResponse {
  /** Session token for accounts API */
  sessionToken: string;
  /** Authenticated identity */
  identity: {
    id: string;
    email: string;
    name: string;
  };
}

/**
 * Token poll error responses.
 */
export type DeviceTokenError =
  | "authorization_pending" // User hasn't completed flow yet
  | "slow_down" // CLI is polling too fast
  | "expired_token" // Device code expired
  | "access_denied"; // User denied access

/**
 * Internal device authorization state.
 * Stored in memory during the device flow.
 */
export interface DeviceAuthState {
  /** The device code (hashed for storage) */
  deviceCode: string;
  /** User code displayed in browser */
  userCode: string;
  /** OAuth provider */
  provider: OAuthProvider;
  /** When this authorization expires */
  expiresAt: Date;
  /** Last poll time (for rate limiting) */
  lastPoll: Date | null;
  /** OAuth state parameter (CSRF protection) */
  oauthState: string;
  /** Set when user completes OAuth flow */
  authorizedIdentityId: string | null;
  /** Set if user denies access */
  denied: boolean;
}

/**
 * OAuth provider configuration.
 */
export interface OAuthProviderConfig {
  /** Provider identifier */
  provider: OAuthProvider;
  /** OAuth authorization URL */
  authorizationUrl: string;
  /** OAuth token URL */
  tokenUrl: string;
  /** OAuth userinfo URL */
  userinfoUrl: string;
  /** OAuth scopes to request */
  scopes: string[];
  /** Client ID (from environment) */
  clientId: string;
  /** Client secret (from environment) */
  clientSecret: string;
}

/**
 * User info from OAuth provider.
 */
export interface OAuthUserInfo {
  /** Provider's unique account ID */
  providerAccountId: string;
  /** User's email */
  email: string;
  /** User's display name */
  name: string;
}
