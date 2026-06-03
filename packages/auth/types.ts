/**
 * Types for the auth runtime layer (authStore).
 *
 * Thin wrappers over the auth schema SQL functions
 * (packages/database/auth/migrate/idempotent/*.sql). No table queries in TS.
 */

export type OAuthProvider = "google" | "github";

export interface User {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface CreateUserOptions {
  emailVerified?: boolean;
  image?: string;
}

/** What validate_session returns: the session plus its user. */
export interface ValidatedSession {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  expiresAt: Date;
}

/** A freshly minted session — the raw token is returned once, only its hash is stored. */
export interface CreatedSession {
  sessionId: string;
  token: string;
}

export interface Account {
  id: string;
  userId: string;
  providerId: OAuthProvider;
  accountId: string;
}

export interface CreatedDeviceAuth {
  deviceCode: string;
  userCode: string;
  oauthState: string;
  /** Seconds until the device authorization expires. */
  expiresIn: number;
}

/** The stored device_authorization state (better-auth-shaped). */
export type DeviceStatus = "pending" | "approved" | "denied";

/**
 * The poll-result vocabulary returned by poll_device: the stored DeviceStatus
 * (pending|approved|denied) passed straight through, plus two poll-only outcomes.
 */
export type DevicePollStatus = DeviceStatus | "expired" | "slow_down";

export interface DevicePollResult {
  status: DevicePollStatus;
  /** Set only when status === "approved". */
  userId: string | null;
}
