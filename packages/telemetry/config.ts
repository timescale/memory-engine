import type { LogfireSDK } from "./types";

/**
 * Lazily-loaded Logfire SDK.
 * Only imported when LOGFIRE_TOKEN is set.
 */
let sdk: LogfireSDK | undefined;

/**
 * Check if Logfire is enabled (LOGFIRE_TOKEN is set and SDK loaded).
 */
export function isEnabled(): boolean {
  return sdk !== undefined;
}

/**
 * Get the loaded SDK or undefined if not enabled.
 * Internal use only - other modules use this to check before calling SDK.
 */
export function getSDK(): LogfireSDK | undefined {
  return sdk;
}

/**
 * Custom scrubbing patterns for memory engine.
 * Added to Logfire's default patterns (password, secret, api_key, jwt, etc.)
 */
const CUSTOM_SCRUB_PATTERNS = [
  "content", // Memory content - potentially sensitive user data
  "embedding", // Vector embeddings - large, not useful in traces
  "access_token", // OAuth access tokens
  "refresh_token", // OAuth refresh tokens
];

/**
 * Initialize Logfire if LOGFIRE_TOKEN environment variable is set.
 * Must be called once at application startup, before Bun.serve().
 *
 * When LOGFIRE_TOKEN is not set, all telemetry functions become no-ops
 * with zero overhead - the SDK is never imported.
 */
export async function configure(): Promise<void> {
  const token = process.env.LOGFIRE_TOKEN;
  if (!token) {
    return;
  }

  // Lazy import - only load SDK when token is present
  sdk = await import("@pydantic/logfire-node");

  // Version could come from package.json or environment
  const version = process.env.npm_package_version ?? "0.0.0";

  sdk.configure({
    token,
    serviceName: "memory-engine",
    serviceVersion: version,
    scrubbing: {
      extraPatterns: CUSTOM_SCRUB_PATTERNS,
    },
  });
}
