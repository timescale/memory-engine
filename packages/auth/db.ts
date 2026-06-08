import { AUTH_SCHEMA } from "@memory.build/database";
import type { Sql } from "postgres";
import {
  DEVICE_CODE_EXPIRY_SECONDS,
  generateDeviceCode,
  generateOAuthState,
  generateSessionToken,
  generateUserCode,
  hashSessionToken,
  normalizeUserCode,
} from "./token";
import type {
  Account,
  CreatedDeviceAuth,
  CreatedSession,
  CreateUserOptions,
  DevicePollResult,
  DevicePollStatus,
  DeviceStatus,
  OAuthProvider,
  User,
  ValidatedSession,
} from "./types";

// Initial session lifetime at login. Sessions are rolling: validate_session
// slides expiry forward to now + this window on use (throttled to ~once/day),
// with no absolute cap — better-auth's model (expiresIn=7d, updateAge=1d). Keep
// this in sync with the window in auth migrate 002_session.sql validate_session.
const SESSION_EXPIRY_DAYS = 7;

/**
 * The auth control-plane data layer.
 *
 * Thin wrappers over the auth schema SQL functions; every method calls a
 * function (none query auth tables directly). Token generation/hashing is the
 * only TS-side logic (the DB stores only hashes).
 */
export interface AuthStore {
  createUser(
    email: string,
    name: string,
    opts?: CreateUserOptions,
  ): Promise<string>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;

  /** Mint a session; returns the one-time raw token (only its hash is stored). */
  createSession(
    userId: string,
    opts?: { expiresInDays?: number },
  ): Promise<CreatedSession>;
  validateSession(token: string): Promise<ValidatedSession | null>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessionsByUser(userId: string): Promise<number>;
  cleanupExpiredSessions(): Promise<number>;

  upsertAccount(
    userId: string,
    providerId: OAuthProvider,
    accountId: string,
  ): Promise<string>;
  getAccountByProvider(
    providerId: OAuthProvider,
    accountId: string,
  ): Promise<Account | null>;
  getAccountsByUser(userId: string): Promise<Account[]>;
  unlinkAccount(id: string): Promise<boolean>;

  /** Start a device flow; generates the codes and returns them. */
  createDeviceAuth(provider: OAuthProvider): Promise<CreatedDeviceAuth>;
  getDeviceByUserCode(userCode: string): Promise<DeviceAuthRow | null>;
  getDeviceByOAuthState(oauthState: string): Promise<DeviceAuthRow | null>;
  /** Resolve the poll state machine in one call (see poll_device). */
  pollDevice(
    deviceCode: string,
    minIntervalSecs?: number,
  ): Promise<DevicePollResult>;
  /** Callback bound the resolved user (status stays 'pending' until consent). */
  bindDeviceUser(deviceCode: string, userId: string): Promise<boolean>;
  /** Consent: approve the bound device (→ 'approved'). */
  approveDevice(deviceCode: string): Promise<boolean>;
  /** Consent denied, or OAuth failed (→ 'denied'). */
  denyDevice(deviceCode: string): Promise<boolean>;
  deleteDevice(deviceCode: string): Promise<boolean>;
  deleteExpiredDevices(): Promise<number>;

  withTransaction<T>(fn: (db: AuthStore) => Promise<T>): Promise<T>;
}

/** A device authorization row (the get_device_by_* lookups). */
export interface DeviceAuthRow {
  deviceCode: string;
  userCode: string;
  provider: OAuthProvider;
  oauthState: string;
  expiresAt: Date;
  lastPoll: Date | null;
  userId: string | null;
  status: DeviceStatus;
  createdAt: Date;
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    emailVerified: Boolean(row.email_verified),
    image: (row.image as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: (row.updated_at as Date | null) ?? null,
  };
}

function mapAccount(row: Record<string, unknown>): Account {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    providerId: row.provider_id as OAuthProvider,
    accountId: row.account_id as string,
  };
}

function mapDevice(row: Record<string, unknown>): DeviceAuthRow {
  return {
    deviceCode: row.device_code as string,
    userCode: row.user_code as string,
    provider: row.provider as OAuthProvider,
    oauthState: row.oauth_state as string,
    expiresAt: row.expires_at as Date,
    lastPoll: (row.last_poll as Date | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    status: row.status as DeviceStatus,
    createdAt: row.created_at as Date,
  };
}

export function authStore(sql: Sql, schema: string = AUTH_SCHEMA): AuthStore {
  const sch = sql(schema);

  const db: AuthStore = {
    async createUser(email, name, opts) {
      const [row] = await sql`
        select ${sch}.create_user(
          ${email}, ${name}, ${opts?.emailVerified ?? false}, ${opts?.image ?? null}
        ) as id`;
      if (!row) throw new Error("create_user returned no row");
      return row.id as string;
    },

    async getUser(id) {
      const [row] = await sql`select * from ${sch}.get_user(${id})`;
      return row ? mapUser(row) : null;
    },

    async getUserByEmail(email) {
      const [row] = await sql`select * from ${sch}.get_user_by_email(${email})`;
      return row ? mapUser(row) : null;
    },

    async createSession(userId, opts) {
      const token = generateSessionToken();
      const tokenHash = hashSessionToken(token);
      const days = opts?.expiresInDays ?? SESSION_EXPIRY_DAYS;
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const [row] = await sql`
        select ${sch}.create_session(${userId}, ${tokenHash}, ${expiresAt}) as id`;
      if (!row) throw new Error("create_session returned no row");
      return { sessionId: row.id as string, token };
    },

    async validateSession(token) {
      const tokenHash = hashSessionToken(token);
      const [row] = await sql`
        select * from ${sch}.validate_session(${tokenHash})`;
      if (!row) return null;
      return {
        sessionId: row.session_id as string,
        userId: row.user_id as string,
        email: row.email as string,
        name: row.name as string,
        expiresAt: row.expires_at as Date,
      };
    },

    async deleteSession(id) {
      const [row] = await sql`select ${sch}.delete_session(${id}) as ok`;
      return Boolean(row?.ok);
    },

    async deleteSessionsByUser(userId) {
      const [row] = await sql`
        select ${sch}.delete_sessions_by_user(${userId}) as n`;
      return Number(row?.n);
    },

    async cleanupExpiredSessions() {
      const [row] = await sql`select ${sch}.cleanup_expired_sessions() as n`;
      return Number(row?.n);
    },

    async upsertAccount(userId, providerId, accountId) {
      const [row] = await sql`
        select ${sch}.upsert_account(${userId}, ${providerId}, ${accountId}) as id`;
      if (!row) throw new Error("upsert_account returned no row");
      return row.id as string;
    },

    async getAccountByProvider(providerId, accountId) {
      const [row] = await sql`
        select * from ${sch}.get_account_by_provider(${providerId}, ${accountId})`;
      return row ? mapAccount(row) : null;
    },

    async getAccountsByUser(userId) {
      const rows = await sql`
        select * from ${sch}.get_accounts_by_user(${userId})`;
      return rows.map(mapAccount);
    },

    async unlinkAccount(id) {
      const [row] = await sql`select ${sch}.unlink_account(${id}) as ok`;
      return Boolean(row?.ok);
    },

    async createDeviceAuth(provider) {
      const deviceCode = generateDeviceCode();
      const userCode = generateUserCode();
      const oauthState = generateOAuthState();
      const expiresAt = new Date(
        Date.now() + DEVICE_CODE_EXPIRY_SECONDS * 1000,
      );
      await sql`
        select ${sch}.create_device_auth(
          ${deviceCode}, ${userCode}, ${provider}, ${oauthState}, ${expiresAt}
        )`;
      return {
        deviceCode,
        userCode,
        oauthState,
        expiresIn: DEVICE_CODE_EXPIRY_SECONDS,
      };
    },

    async getDeviceByUserCode(userCode) {
      const [row] = await sql`
        select * from ${sch}.get_device_by_user_code(${normalizeUserCode(userCode)})`;
      return row ? mapDevice(row) : null;
    },

    async getDeviceByOAuthState(oauthState) {
      const [row] = await sql`
        select * from ${sch}.get_device_by_oauth_state(${oauthState})`;
      return row ? mapDevice(row) : null;
    },

    async pollDevice(deviceCode, minIntervalSecs) {
      const [row] = await sql`
        select * from ${sch}.poll_device(${deviceCode}, ${minIntervalSecs ?? 5})`;
      return {
        status: (row?.status as DevicePollStatus) ?? "expired",
        userId: (row?.user_id as string | null) ?? null,
      };
    },

    async bindDeviceUser(deviceCode, userId) {
      const [row] = await sql`
        select ${sch}.bind_device_user(${deviceCode}, ${userId}) as ok`;
      return Boolean(row?.ok);
    },

    async approveDevice(deviceCode) {
      const [row] = await sql`
        select ${sch}.approve_device(${deviceCode}) as ok`;
      return Boolean(row?.ok);
    },

    async denyDevice(deviceCode) {
      const [row] = await sql`select ${sch}.deny_device(${deviceCode}) as ok`;
      return Boolean(row?.ok);
    },

    async deleteDevice(deviceCode) {
      const [row] = await sql`select ${sch}.delete_device(${deviceCode}) as ok`;
      return Boolean(row?.ok);
    },

    async deleteExpiredDevices() {
      const [row] = await sql`select ${sch}.delete_expired_devices() as n`;
      return Number(row?.n);
    },

    async withTransaction<T>(fn: (db: AuthStore) => Promise<T>): Promise<T> {
      return sql.begin((tx) =>
        fn(authStore(tx as unknown as Sql, schema)),
      ) as Promise<T>;
    },
  };

  return db;
}
