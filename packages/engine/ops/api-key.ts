import type {
  ApiKeyInfo,
  CreateApiKeyResult,
  OpsContext,
  ValidateApiKeyResult,
} from "../types";
import {
  formatApiKey,
  generateLookupId,
  generateSecret,
  hashSecret,
  parseApiKey,
  verifySecret,
} from "../util/api-key";
import { withTx } from "./_tx";

// Row type from database
interface ApiKeyRow {
  id: string;
  principal_id: string;
  name: string;
  lookup_id: string;
  key_hash: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date | null;
}

interface ValidateRow {
  id: string;
  principal_id: string;
  key_hash: string;
  superuser: boolean;
  createrole: boolean;
  can_login: boolean;
}

function rowToApiKeyInfo(row: ApiKeyRow): ApiKeyInfo {
  return {
    id: row.id,
    principalId: row.principal_id,
    name: row.name,
    lookupId: row.lookup_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function apiKeyOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Create a new API key for a principal
     */
    async createApiKey(
      principalId: string,
      name: string,
      expiresAt?: Date,
    ): Promise<CreateApiKeyResult> {
      const lookupId = generateLookupId();
      const secret = generateSecret();
      const keyHash = await hashSecret(secret);
      const key = formatApiKey(schema, lookupId, secret);

      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into ${sql.unsafe(schema)}.api_key
            (principal_id, name, lookup_id, key_hash, expires_at)
          values
            (${principalId}, ${name}, ${lookupId}, ${keyHash}, ${expiresAt ?? "infinity"})
          returning id
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create API key");
        }
        return {
          key,
          id: row.id,
          lookupId,
        };
      });
    },

    /**
     * Validate an API key and return the associated principal info
     */
    async validateApiKey(key: string): Promise<ValidateApiKeyResult | null> {
      const parsed = parseApiKey(key);
      if (!parsed) {
        return null;
      }

      const { lookupId, secret } = parsed;

      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<ValidateRow[]>`
          select k.id, k.principal_id, k.key_hash, p.superuser, p.createrole, p.can_login
          from ${sql.unsafe(schema)}.api_key k
          join ${sql.unsafe(schema)}.principal p on p.id = k.principal_id
          where k.lookup_id = ${lookupId}
            and k.expires_at > now()
        `;

        const row = rows[0];
        if (!row) {
          return null;
        }
        const valid = await verifySecret(secret, row.key_hash);
        if (!valid) {
          return null;
        }

        return {
          principalId: row.principal_id,
          superuser: row.superuser,
          createrole: row.createrole,
          canLogin: row.can_login,
        };
      });
    },

    /**
     * List API keys for a principal (without secrets)
     */
    async listApiKeys(principalId: string): Promise<ApiKeyInfo[]> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<ApiKeyRow[]>`
          select id, principal_id, name, lookup_id, key_hash, expires_at, created_at, updated_at
          from ${sql.unsafe(schema)}.api_key
          where principal_id = ${principalId}
          order by created_at
        `;
        return rows.map(rowToApiKeyInfo);
      });
    },

    /**
     * Revoke an API key
     */
    async revokeApiKey(principalId: string, keyId: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.api_key
          where id = ${keyId}
            and principal_id = ${principalId}
        `;
        return result.count > 0;
      });
    },
  };
}

export type ApiKeyOps = ReturnType<typeof apiKeyOps>;
