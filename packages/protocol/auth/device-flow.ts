/**
 * OAuth device flow schemas — request/response types for HTTP auth endpoints.
 *
 * These cover the non-RPC HTTP endpoints used for CLI authentication:
 *   POST /api/v1/auth/device/code
 *   POST /api/v1/auth/device/token
 */
import { z } from "zod";

// =============================================================================
// Supported Providers
// =============================================================================

/**
 * Supported OAuth providers.
 */
export const oauthProviderSchema = z.enum(["google", "github"]);

export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

// =============================================================================
// Device Code Request/Response
// =============================================================================

/**
 * POST /api/v1/auth/device/code — request body.
 */
export const deviceCodeRequestSchema = z.object({
  provider: oauthProviderSchema,
});

export type DeviceCodeRequest = z.infer<typeof deviceCodeRequestSchema>;

/**
 * POST /api/v1/auth/device/code — success response.
 */
export const deviceCodeResponseSchema = z.object({
  /** Unique device identifier for polling */
  deviceCode: z.string(),
  /** Code the user enters in the browser */
  userCode: z.string(),
  /** URL where user enters the code */
  verificationUri: z.string(),
  /** How long the codes are valid (seconds) */
  expiresIn: z.number(),
  /** How often CLI should poll (seconds) */
  interval: z.number(),
});

export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;

// =============================================================================
// Device Token Request/Response
// =============================================================================

/**
 * POST /api/v1/auth/device/token — request body.
 */
export const deviceTokenRequestSchema = z.object({
  deviceCode: z.string(),
});

export type DeviceTokenRequest = z.infer<typeof deviceTokenRequestSchema>;

/**
 * POST /api/v1/auth/device/token — success response.
 */
export const deviceTokenResponseSchema = z.object({
  /** Session token for accounts API */
  sessionToken: z.string(),
  /** Authenticated identity */
  identity: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  }),
});

export type DeviceTokenResponse = z.infer<typeof deviceTokenResponseSchema>;

/**
 * Token poll error codes.
 */
export const deviceTokenErrorSchema = z.enum([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
]);

export type DeviceTokenError = z.infer<typeof deviceTokenErrorSchema>;
