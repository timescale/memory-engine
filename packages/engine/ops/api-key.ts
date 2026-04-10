import type {
  ApiKey,
  CreateApiKeyParams,
  CreateApiKeyResult,
  OpsContext,
  ValidateApiKeyResult,
} from "../types";
import {
  formatApiKey,
  generateLookupId,
  generateSecret,
  hashSecret,
  verifySecret,
} from "../util/api-key";
import { withTx } from "./_tx";

// Row type from database
interface ApiKeyRow {
  id: string;
  user_id: string;
  lookup_id: string;
  key_hash: string;
  name: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    lookupId: row.lookup_id,
    name: row.name,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function apiKeyOps(ctx: OpsContext, engineSlug: string) {
  const { schema } = ctx;

  return {
    /**
     * Create a new API key for a user
     * Returns the full key string (only available at creation time)
     */
    async createApiKey(
      params: CreateApiKeyParams,
    ): Promise<CreateApiKeyResult> {
      const { userId, name, expiresAt = null } = params;

      const lookupId = generateLookupId();
      const secret = generateSecret();
      const keyHash = await hashSecret(secret);
      const rawKey = formatApiKey(engineSlug, lookupId, secret);

      return withTx(ctx, "admin", "createApiKey", async (sql) => {
        const rows = await sql<ApiKeyRow[]>`
          insert into ${sql.unsafe(schema)}.api_key
            (user_id, lookup_id, key_hash, name, expires_at)
          values
            (${userId}, ${lookupId}, ${keyHash}, ${name}, ${expiresAt})
          returning id, user_id, lookup_id, key_hash, name, expires_at, last_used_at, created_at, revoked_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create API key");
        }
        return {
          apiKey: rowToApiKey(row),
          rawKey,
        };
      });
    },

    /**
     * Validate an API key and return the user ID if valid
     */
    async validateApiKey(
      lookupId: string,
      secret: string,
    ): Promise<ValidateApiKeyResult> {
      return withTx(ctx, "admin", "validateApiKey", async (sql) => {
        const [row] = await sql<ApiKeyRow[]>`
          select id, user_id, lookup_id, key_hash, name, expires_at, last_used_at, created_at, revoked_at
          from ${sql.unsafe(schema)}.api_key
          where lookup_id = ${lookupId}
        `;

        if (!row) {
          return { valid: false, error: "API key not found" };
        }

        if (row.revoked_at) {
          return { valid: false, error: "API key has been revoked" };
        }

        if (row.expires_at && row.expires_at < new Date()) {
          return { valid: false, error: "API key has expired" };
        }

        const secretValid = await verifySecret(secret, row.key_hash);
        if (!secretValid) {
          return { valid: false, error: "Invalid API key secret" };
        }

        // Update last_used_at
        await sql`
          update ${sql.unsafe(schema)}.api_key
          set last_used_at = now()
          where id = ${row.id}
        `;

        return {
          valid: true,
          userId: row.user_id,
          apiKeyId: row.id,
        };
      });
    },

    /**
     * Get an API key by ID (without the secret/hash)
     */
    async getApiKey(id: string): Promise<ApiKey | null> {
      return withTx(ctx, "admin", "getApiKey", async (sql) => {
        const [row] = await sql<ApiKeyRow[]>`
          select id, user_id, lookup_id, key_hash, name, expires_at, last_used_at, created_at, revoked_at
          from ${sql.unsafe(schema)}.api_key
          where id = ${id}
        `;
        return row ? rowToApiKey(row) : null;
      });
    },

    /**
     * List all API keys for a user
     */
    async listApiKeys(userId: string): Promise<ApiKey[]> {
      return withTx(ctx, "admin", "listApiKeys", async (sql) => {
        const rows = await sql<ApiKeyRow[]>`
          select id, user_id, lookup_id, key_hash, name, expires_at, last_used_at, created_at, revoked_at
          from ${sql.unsafe(schema)}.api_key
          where user_id = ${userId}
          order by created_at desc
        `;
        return rows.map(rowToApiKey);
      });
    },

    /**
     * Revoke an API key
     */
    async revokeApiKey(id: string): Promise<boolean> {
      return withTx(ctx, "admin", "revokeApiKey", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.api_key
          set revoked_at = now()
          where id = ${id}
            and revoked_at is null
        `;
        return result.count > 0;
      });
    },

    /**
     * Delete an API key permanently
     */
    async deleteApiKey(id: string): Promise<boolean> {
      return withTx(ctx, "admin", "deleteApiKey", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.api_key
          where id = ${id}
        `;
        return result.count > 0;
      });
    },
  };
}

export type ApiKeyOps = ReturnType<typeof apiKeyOps>;
