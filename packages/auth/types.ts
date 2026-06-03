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

export type DevicePollStatus =
  | "expired"
  | "slow_down"
  | "denied"
  | "pending"
  | "authorized";

export interface DevicePollResult {
  status: DevicePollStatus;
  /** Set only when status === "authorized". */
  userId: string | null;
}
