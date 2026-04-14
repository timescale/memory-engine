import type { SQL } from "bun";

// =============================================================================
// Context
// =============================================================================

export interface AccountsCrypto {
  encrypt(plaintext: string): Promise<{ ciphertext: string; keyId: number }>;
  decrypt(ciphertext: string, keyId: number): Promise<string>;
  createDataKey(): Promise<number>;
  activateDataKey(keyId: number): Promise<void>;
}

export interface AccountsContext {
  sql: SQL;
  schema: string;
  inTransaction: boolean;
  crypto: AccountsCrypto;
}

// =============================================================================
// Errors
// =============================================================================

export type AccountsErrorCode =
  | "ORG_MUST_HAVE_OWNER"
  | "IDENTITY_NOT_FOUND"
  | "ORG_NOT_FOUND"
  | "ENGINE_NOT_FOUND"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_ACCEPTED"
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "OAUTH_ACCOUNT_NOT_FOUND"
  | "DUPLICATE_SLUG"
  | "DUPLICATE_EMAIL"
  | "ENCRYPTION_KEY_NOT_FOUND"
  | "NO_ACTIVE_ENCRYPTION_KEY";

export class AccountsError extends Error {
  constructor(
    public code: AccountsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountsError";
  }
}

// =============================================================================
// Identity
// =============================================================================

export interface Identity {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface CreateIdentityParams {
  id?: string;
  email: string;
  name: string;
}

// =============================================================================
// Org
// =============================================================================

export interface Org {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface CreateOrgParams {
  id?: string;
  name: string;
}

// =============================================================================
// OrgMember
// =============================================================================

export type OrgRole = "owner" | "admin" | "member";

export interface OrgMember {
  orgId: string;
  identityId: string;
  role: OrgRole;
  createdAt: Date;
  name: string;
  email: string;
}

// =============================================================================
// Engine
// =============================================================================

export type EngineStatus = "active" | "suspended" | "deleted";

export interface Engine {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  shardId: number;
  status: EngineStatus;
  language: string;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface CreateEngineParams {
  id?: string;
  orgId: string;
  name: string;
  shardId?: number;
  language?: string; // defaults to 'english'
}

// =============================================================================
// Invitation
// =============================================================================

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

export interface CreateInvitationParams {
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  expiresInDays?: number;
}

export interface CreateInvitationResult {
  invitation: Invitation;
  rawToken: string;
}

// =============================================================================
// OAuthAccount
// =============================================================================

export type OAuthProvider = "google" | "github";

export interface OAuthAccount {
  id: string;
  identityId: string;
  provider: OAuthProvider;
  providerAccountId: string;
  email: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface LinkOAuthParams {
  identityId: string;
  provider: OAuthProvider;
  providerAccountId: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
}

// =============================================================================
// Session
// =============================================================================

export interface Session {
  id: string;
  identityId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateSessionParams {
  identityId: string;
  expiresInDays?: number;
}

export interface CreateSessionResult {
  session: Session;
  rawToken: string;
}

// =============================================================================
// EncryptionKey
// =============================================================================

export interface EncryptionKey {
  id: number;
  active: boolean;
  createdAt: Date;
}

// =============================================================================
// DeviceAuthorization (OAuth Device Flow)
// =============================================================================

export type DeviceProvider = "google" | "github";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  provider: DeviceProvider;
  oauthState: string;
  expiresAt: Date;
  lastPoll: Date | null;
  identityId: string | null;
  denied: boolean;
  createdAt: Date;
}

export interface CreateDeviceAuthParams {
  deviceCode: string;
  userCode: string;
  provider: DeviceProvider;
  oauthState: string;
  expiresAt: Date;
}
