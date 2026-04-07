/**
 * OAuth device flow state management.
 *
 * Manages in-memory state for device authorization flows.
 * State is ephemeral - lost on server restart. This is acceptable because:
 * 1. Device codes expire quickly (15 minutes default)
 * 2. Users can simply restart the flow
 * 3. No sensitive data is persisted
 */

import type { DeviceAuthState, OAuthProvider } from "./types";

/** Device code expiration (15 minutes) */
const DEVICE_CODE_EXPIRY_MS = 15 * 60 * 1000;

/** Minimum polling interval (5 seconds) */
const MIN_POLL_INTERVAL_MS = 5 * 1000;

/** User code length (8 characters, alphanumeric, easy to type) */
const USER_CODE_LENGTH = 8;

/** Device code length (32 bytes, URL-safe base64) */
const DEVICE_CODE_LENGTH = 32;

/** OAuth state length (16 bytes, URL-safe base64) */
const OAUTH_STATE_LENGTH = 16;

/**
 * In-memory store for device authorization states.
 * Key: device_code
 */
const deviceStates = new Map<string, DeviceAuthState>();

/**
 * Index from user_code to device_code for quick lookup.
 */
const userCodeIndex = new Map<string, string>();

/**
 * Index from oauth_state to device_code for callback lookup.
 */
const oauthStateIndex = new Map<string, string>();

/**
 * Generate a cryptographically secure random string.
 */
function generateRandomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Generate a user-friendly code (uppercase alphanumeric, no ambiguous chars).
 * Format: XXXX-XXXX (8 chars with hyphen separator for readability)
 */
function generateUserCode(): string {
  // Exclude ambiguous characters: 0, O, 1, I, L
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = new Uint8Array(USER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    code += chars[byte % chars.length];
  }
  // Insert hyphen for readability: XXXX-XXXX
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Create a new device authorization.
 *
 * @returns Device code, user code, and expiry info
 */
export function createDeviceAuthorization(provider: OAuthProvider): {
  deviceCode: string;
  userCode: string;
  oauthState: string;
  expiresIn: number;
  interval: number;
} {
  const deviceCode = generateRandomString(DEVICE_CODE_LENGTH);
  const userCode = generateUserCode();
  const oauthState = generateRandomString(OAUTH_STATE_LENGTH);
  const expiresAt = new Date(Date.now() + DEVICE_CODE_EXPIRY_MS);

  const state: DeviceAuthState = {
    deviceCode,
    userCode,
    provider,
    expiresAt,
    lastPoll: null,
    oauthState,
    authorizedIdentityId: null,
    denied: false,
  };

  // Store state
  deviceStates.set(deviceCode, state);
  userCodeIndex.set(userCode, deviceCode);
  oauthStateIndex.set(oauthState, deviceCode);

  return {
    deviceCode,
    userCode,
    oauthState,
    expiresIn: Math.floor(DEVICE_CODE_EXPIRY_MS / 1000),
    interval: Math.floor(MIN_POLL_INTERVAL_MS / 1000),
  };
}

/**
 * Get device state by user code.
 * Used when user enters code in browser.
 */
export function getDeviceStateByUserCode(
  userCode: string,
): DeviceAuthState | null {
  // Normalize: uppercase, remove hyphen
  const normalized = userCode.toUpperCase().replace(/-/g, "");
  // Reconstruct with hyphen
  const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

  const deviceCode = userCodeIndex.get(formatted);
  if (!deviceCode) {
    return null;
  }

  const state = deviceStates.get(deviceCode);
  if (!state) {
    return null;
  }

  // Check expiry
  if (new Date() > state.expiresAt) {
    cleanupDeviceState(deviceCode);
    return null;
  }

  return state;
}

/**
 * Get device state by OAuth state parameter.
 * Used in OAuth callback to find the device being authorized.
 */
export function getDeviceStateByOAuthState(
  oauthState: string,
): DeviceAuthState | null {
  const deviceCode = oauthStateIndex.get(oauthState);
  if (!deviceCode) {
    return null;
  }

  const state = deviceStates.get(deviceCode);
  if (!state) {
    return null;
  }

  // Check expiry
  if (new Date() > state.expiresAt) {
    cleanupDeviceState(deviceCode);
    return null;
  }

  return state;
}

/**
 * Get device state by device code.
 * Used for polling.
 */
export function getDeviceStateByDeviceCode(
  deviceCode: string,
): DeviceAuthState | null {
  const state = deviceStates.get(deviceCode);
  if (!state) {
    return null;
  }

  // Check expiry
  if (new Date() > state.expiresAt) {
    cleanupDeviceState(deviceCode);
    return null;
  }

  return state;
}

/**
 * Check if polling is too fast (rate limiting).
 *
 * @returns true if client should slow down
 */
export function checkPollRateLimit(deviceCode: string): boolean {
  const state = deviceStates.get(deviceCode);
  if (!state) {
    return false;
  }

  const now = new Date();
  if (state.lastPoll) {
    const elapsed = now.getTime() - state.lastPoll.getTime();
    if (elapsed < MIN_POLL_INTERVAL_MS) {
      return true; // Too fast
    }
  }

  // Update last poll time
  state.lastPoll = now;
  return false;
}

/**
 * Mark device as authorized with an identity.
 * Called after successful OAuth callback.
 */
export function authorizeDevice(
  deviceCode: string,
  identityId: string,
): boolean {
  const state = deviceStates.get(deviceCode);
  if (!state) {
    return false;
  }

  // Check expiry
  if (new Date() > state.expiresAt) {
    cleanupDeviceState(deviceCode);
    return false;
  }

  state.authorizedIdentityId = identityId;
  return true;
}

/**
 * Mark device as denied.
 * Called if user denies access.
 */
export function denyDevice(deviceCode: string): boolean {
  const state = deviceStates.get(deviceCode);
  if (!state) {
    return false;
  }

  state.denied = true;
  return true;
}

/**
 * Clean up device state after completion or expiry.
 */
export function cleanupDeviceState(deviceCode: string): void {
  const state = deviceStates.get(deviceCode);
  if (state) {
    userCodeIndex.delete(state.userCode);
    oauthStateIndex.delete(state.oauthState);
    deviceStates.delete(deviceCode);
  }
}

/**
 * Clean up all expired device states.
 * Should be called periodically.
 */
export function cleanupExpiredStates(): number {
  const now = new Date();
  let count = 0;

  for (const [deviceCode, state] of deviceStates) {
    if (now > state.expiresAt) {
      cleanupDeviceState(deviceCode);
      count++;
    }
  }

  return count;
}

/**
 * Get count of active device authorizations (for monitoring).
 */
export function getActiveDeviceCount(): number {
  return deviceStates.size;
}
