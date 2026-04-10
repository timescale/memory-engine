import type {
  AccountsContext,
  CreateDeviceAuthParams,
  DeviceAuthorization,
  DeviceProvider,
} from "../types";
import { withTx } from "./_tx";

interface DeviceAuthRow {
  device_code: string;
  user_code: string;
  provider: string;
  oauth_state: string;
  expires_at: Date;
  last_poll: Date | null;
  identity_id: string | null;
  denied: boolean;
  created_at: Date;
}

function rowToDeviceAuth(row: DeviceAuthRow): DeviceAuthorization {
  return {
    deviceCode: row.device_code,
    userCode: row.user_code,
    provider: row.provider as DeviceProvider,
    oauthState: row.oauth_state,
    expiresAt: row.expires_at,
    lastPoll: row.last_poll,
    identityId: row.identity_id,
    denied: row.denied,
    createdAt: row.created_at,
  };
}

export function deviceAuthOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    /**
     * Create a new device authorization.
     */
    async create(params: CreateDeviceAuthParams): Promise<DeviceAuthorization> {
      const { deviceCode, userCode, provider, oauthState, expiresAt } = params;

      return withTx(ctx, "createDeviceAuth", async (sql) => {
        const rows = await sql<DeviceAuthRow[]>`
          insert into ${sql.unsafe(schema)}.device_authorization
            (device_code, user_code, provider, oauth_state, expires_at)
          values
            (${deviceCode}, ${userCode}, ${provider}, ${oauthState}, ${expiresAt})
          returning *
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create device authorization");
        }
        return rowToDeviceAuth(row);
      });
    },

    /**
     * Get device authorization by device code (for CLI polling).
     * Returns null if not found or expired.
     */
    async getByDeviceCode(
      deviceCode: string,
    ): Promise<DeviceAuthorization | null> {
      return withTx(ctx, "getDeviceByCode", async (sql) => {
        const rows = await sql<DeviceAuthRow[]>`
          select * from ${sql.unsafe(schema)}.device_authorization
          where device_code = ${deviceCode}
            and expires_at > now()
        `;
        const row = rows[0];
        return row ? rowToDeviceAuth(row) : null;
      });
    },

    /**
     * Get device authorization by user code (for browser code entry).
     * Normalizes input: uppercase, removes hyphens, reconstructs format.
     * Returns null if not found or expired.
     */
    async getByUserCode(userCode: string): Promise<DeviceAuthorization | null> {
      // Normalize: uppercase, remove hyphen, reconstruct XXXX-XXXX
      const normalized = userCode.toUpperCase().replace(/-/g, "");
      const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

      return withTx(ctx, "getDeviceByUserCode", async (sql) => {
        const rows = await sql<DeviceAuthRow[]>`
          select * from ${sql.unsafe(schema)}.device_authorization
          where user_code = ${formatted}
            and expires_at > now()
        `;
        const row = rows[0];
        return row ? rowToDeviceAuth(row) : null;
      });
    },

    /**
     * Get device authorization by OAuth state (for callback).
     * Returns null if not found or expired.
     */
    async getByOAuthState(
      oauthState: string,
    ): Promise<DeviceAuthorization | null> {
      return withTx(ctx, "getDeviceByOAuthState", async (sql) => {
        const rows = await sql<DeviceAuthRow[]>`
          select * from ${sql.unsafe(schema)}.device_authorization
          where oauth_state = ${oauthState}
            and expires_at > now()
        `;
        const row = rows[0];
        return row ? rowToDeviceAuth(row) : null;
      });
    },

    /**
     * Update last poll time for rate limiting.
     * Returns the time since last poll in milliseconds, or null if first poll.
     */
    async updateLastPoll(deviceCode: string): Promise<number | null> {
      return withTx(ctx, "updateDeviceLastPoll", async (sql) => {
        const rows = await sql<{ last_poll: Date | null }[]>`
          update ${sql.unsafe(schema)}.device_authorization
          set last_poll = now()
          where device_code = ${deviceCode}
            and expires_at > now()
          returning (
            select last_poll from ${sql.unsafe(schema)}.device_authorization
            where device_code = ${deviceCode}
          ) as last_poll
        `;
        const row = rows[0];
        if (!row || !row.last_poll) {
          return null; // First poll or not found
        }
        return Date.now() - row.last_poll.getTime();
      });
    },

    /**
     * Mark device as authorized with an identity.
     * Returns true if updated, false if not found/expired.
     */
    async authorize(deviceCode: string, identityId: string): Promise<boolean> {
      return withTx(ctx, "authorizeDevice", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.device_authorization
          set identity_id = ${identityId}
          where device_code = ${deviceCode}
            and expires_at > now()
            and identity_id is null
            and denied = false
        `;
        return result.count > 0;
      });
    },

    /**
     * Mark device as denied.
     * Returns true if updated, false if not found/expired.
     */
    async deny(deviceCode: string): Promise<boolean> {
      return withTx(ctx, "denyDevice", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.device_authorization
          set denied = true
          where device_code = ${deviceCode}
            and expires_at > now()
            and identity_id is null
        `;
        return result.count > 0;
      });
    },

    /**
     * Delete a device authorization (cleanup after completion).
     * Returns true if deleted.
     */
    async delete(deviceCode: string): Promise<boolean> {
      return withTx(ctx, "deleteDevice", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.device_authorization
          where device_code = ${deviceCode}
        `;
        return result.count > 0;
      });
    },

    /**
     * Delete all expired device authorizations.
     * Called by cron job. Returns count deleted.
     */
    async deleteExpired(): Promise<number> {
      return withTx(ctx, "deleteExpiredDevices", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.device_authorization
          where expires_at <= now()
        `;
        return result.count;
      });
    },
  };
}

export type DeviceAuthOps = ReturnType<typeof deviceAuthOps>;
