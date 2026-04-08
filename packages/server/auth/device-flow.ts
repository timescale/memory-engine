/**
 * OAuth device flow state management.
 *
 * Manages device authorization state in PostgreSQL for multi-node support.
 * State is persisted to database and cleaned up via cron.
 */

import type { AccountsDB, DeviceAuthorization } from "@memory-engine/accounts";
import type { OAuthProvider } from "./types";

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
export async function createDeviceAuthorization(
  db: AccountsDB,
  provider: OAuthProvider,
): Promise<{
  deviceCode: string;
  userCode: string;
  oauthState: string;
  expiresIn: number;
  interval: number;
}> {
  const deviceCode = generateRandomString(DEVICE_CODE_LENGTH);
  const userCode = generateUserCode();
  const oauthState = generateRandomString(OAUTH_STATE_LENGTH);
  const expiresAt = new Date(Date.now() + DEVICE_CODE_EXPIRY_MS);

  await db.create({
    deviceCode,
    userCode,
    provider,
    oauthState,
    expiresAt,
  });

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
export async function getDeviceStateByUserCode(
  db: AccountsDB,
  userCode: string,
): Promise<DeviceAuthorization | null> {
  return db.getByUserCode(userCode);
}

/**
 * Get device state by OAuth state parameter.
 * Used in OAuth callback to find the device being authorized.
 */
export async function getDeviceStateByOAuthState(
  db: AccountsDB,
  oauthState: string,
): Promise<DeviceAuthorization | null> {
  return db.getByOAuthState(oauthState);
}

/**
 * Get device state by device code.
 * Used for polling.
 */
export async function getDeviceStateByDeviceCode(
  db: AccountsDB,
  deviceCode: string,
): Promise<DeviceAuthorization | null> {
  return db.getByDeviceCode(deviceCode);
}

/**
 * Check if polling is too fast (rate limiting).
 * Also updates the last poll timestamp.
 *
 * @returns true if client should slow down
 */
export async function checkPollRateLimit(
  db: AccountsDB,
  deviceCode: string,
): Promise<boolean> {
  const elapsedMs = await db.updateLastPoll(deviceCode);

  // First poll or not found
  if (elapsedMs === null) {
    return false;
  }

  // Too fast if less than minimum interval
  return elapsedMs < MIN_POLL_INTERVAL_MS;
}

/**
 * Mark device as authorized with an identity.
 * Called after successful OAuth callback.
 */
export async function authorizeDevice(
  db: AccountsDB,
  deviceCode: string,
  identityId: string,
): Promise<boolean> {
  return db.authorize(deviceCode, identityId);
}

/**
 * Mark device as denied.
 * Called if user denies access.
 */
export async function denyDevice(
  db: AccountsDB,
  deviceCode: string,
): Promise<boolean> {
  return db.deny(deviceCode);
}

/**
 * Clean up device state after completion or expiry.
 */
export async function cleanupDeviceState(
  db: AccountsDB,
  deviceCode: string,
): Promise<void> {
  await db.delete(deviceCode);
}

/**
 * Clean up all expired device states.
 * Called by cron job.
 */
export async function cleanupExpiredStates(db: AccountsDB): Promise<number> {
  return db.deleteExpired();
}
