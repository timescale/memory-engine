/**
 * Auth client — OAuth device flow for CLI authentication.
 *
 * Implements the device authorization grant flow:
 * 1. CLI calls startDeviceFlow() to get a user code + verification URL
 * 2. User visits the URL and enters the code in their browser
 * 3. CLI polls with pollForToken() until the user completes auth
 * 4. Returns a session token for use with the accounts client
 *
 * @example
 * ```ts
 * import { createAuthClient } from "@memory-engine/client";
 *
 * const auth = createAuthClient({ url: "http://localhost:3000" });
 *
 * const flow = await auth.startDeviceFlow("github");
 * console.log(`Visit ${flow.verificationUri} and enter code: ${flow.userCode}`);
 *
 * const { sessionToken, identity } = await auth.pollForToken(flow.deviceCode, {
 *   interval: flow.interval,
 *   expiresIn: flow.expiresIn,
 * });
 * ```
 */
import type {
  DeviceCodeResponse,
  DeviceTokenResponse,
  OAuthProvider,
} from "@memory-engine/protocol/auth/device-flow";

// =============================================================================
// Options
// =============================================================================

/**
 * Options for creating an auth client.
 */
export interface AuthClientOptions {
  /** Base URL of the Memory Engine server (default: "http://localhost:3000") */
  url?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Options for polling for a token.
 */
export interface PollOptions {
  /** Polling interval in seconds (from the device code response) */
  interval?: number;
  /** Expiration time in seconds (from the device code response) */
  expiresIn?: number;
  /** Callback invoked on each poll attempt (for progress indication) */
  onPoll?: () => void;
  /** AbortSignal to cancel polling */
  signal?: AbortSignal;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when the device flow fails.
 */
export class DeviceFlowError extends Error {
  /** Error code from the server */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

// =============================================================================
// Client Type
// =============================================================================

/**
 * Auth client for device flow authentication.
 */
export interface AuthClient {
  /**
   * Start a device authorization flow.
   *
   * Returns a device code and user code. The user must visit the
   * verification URI and enter the user code to authorize the device.
   */
  startDeviceFlow(provider: OAuthProvider): Promise<DeviceCodeResponse>;

  /**
   * Poll for a session token after starting a device flow.
   *
   * Repeatedly polls the token endpoint until the user completes
   * authorization, the code expires, or the user denies access.
   *
   * @throws {DeviceFlowError} With code "expired_token" or "access_denied"
   */
  pollForToken(
    deviceCode: string,
    options?: PollOptions,
  ): Promise<DeviceTokenResponse>;
}

// =============================================================================
// Factory
// =============================================================================

const DEFAULT_URL = "http://localhost:3000";
const DEVICE_CODE_PATH = "/api/v1/auth/device/code";
const DEVICE_TOKEN_PATH = "/api/v1/auth/device/token";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_EXPIRES_IN = 900;

/**
 * Create an auth client for device flow authentication.
 *
 * Used by the CLI to authenticate users via OAuth (Google/GitHub).
 *
 * @example
 * ```ts
 * const auth = createAuthClient();
 *
 * // Step 1: Start the flow
 * const flow = await auth.startDeviceFlow("github");
 * console.log(`Visit ${flow.verificationUri}`);
 * console.log(`Enter code: ${flow.userCode}`);
 *
 * // Step 2: Poll until user completes auth
 * const { sessionToken } = await auth.pollForToken(flow.deviceCode, {
 *   interval: flow.interval,
 *   expiresIn: flow.expiresIn,
 * });
 * ```
 */
export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const baseUrl = (options.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  async function startDeviceFlow(
    provider: OAuthProvider,
  ): Promise<DeviceCodeResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${baseUrl}${DEVICE_CODE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new DeviceFlowError(
          "request_failed",
          `Failed to start device flow: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
        );
      }

      return (await response.json()) as DeviceCodeResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollForToken(
    deviceCode: string,
    pollOptions: PollOptions = {},
  ): Promise<DeviceTokenResponse> {
    const interval = (pollOptions.interval ?? DEFAULT_POLL_INTERVAL) * 1000;
    const expiresAt =
      Date.now() + (pollOptions.expiresIn ?? DEFAULT_EXPIRES_IN) * 1000;

    while (Date.now() < expiresAt) {
      // Check abort signal
      if (pollOptions.signal?.aborted) {
        throw new DeviceFlowError("aborted", "Polling was cancelled");
      }

      // Wait before polling
      await sleep(interval);

      pollOptions.onPoll?.();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(`${baseUrl}${DEVICE_TOKEN_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          return (await response.json()) as DeviceTokenResponse;
        }

        // Parse error response
        const body = await response.json().catch(() => ({}));
        const error = (body as { error?: string }).error;

        if (error === "authorization_pending" || error === "slow_down") {
          // Keep polling (slow_down means increase interval, but we keep it simple)
          continue;
        }

        if (error === "expired_token") {
          throw new DeviceFlowError(
            "expired_token",
            "Device code has expired. Please start a new flow.",
          );
        }

        if (error === "access_denied") {
          throw new DeviceFlowError(
            "access_denied",
            "Authorization was denied by the user.",
          );
        }

        // Unknown error
        throw new DeviceFlowError(
          error ?? "unknown",
          `Token request failed: HTTP ${response.status}`,
        );
      } catch (error) {
        clearTimeout(timer);

        // Re-throw DeviceFlowErrors
        if (error instanceof DeviceFlowError) {
          throw error;
        }

        // Network/timeout errors — keep polling
        if (Date.now() >= expiresAt) {
          throw new DeviceFlowError(
            "expired_token",
            "Device code has expired while polling.",
          );
        }
      }
    }

    throw new DeviceFlowError(
      "expired_token",
      "Device code has expired. Please start a new flow.",
    );
  }

  return { startDeviceFlow, pollForToken };
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
