import type {
  AccountsContext,
  LinkOAuthParams,
  OAuthAccount,
  OAuthProvider,
} from "../types";
import { withTx } from "./_tx";

interface OAuthAccountRow {
  id: string;
  identity_id: string;
  provider: OAuthProvider;
  provider_account_id: string;
  email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  encryption_key_id: number | null;
  token_expires_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
}

function rowToOAuthAccount(row: OAuthAccountRow): OAuthAccount {
  return {
    id: row.id,
    identityId: row.identity_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function oauthOps(ctx: AccountsContext) {
  const { schema, crypto } = ctx;

  return {
    async linkOAuthAccount(params: LinkOAuthParams): Promise<OAuthAccount> {
      const {
        identityId,
        provider,
        providerAccountId,
        email,
        accessToken,
        refreshToken,
        tokenExpiresAt,
      } = params;

      // Encrypt tokens
      const { ciphertext: encryptedAccess, keyId } =
        await crypto.encrypt(accessToken);
      const encryptedRefresh = refreshToken
        ? (await crypto.encrypt(refreshToken)).ciphertext
        : null;

      return withTx(ctx, "linkOAuthAccount", async (sql) => {
        const rows = await sql<OAuthAccountRow[]>`
          insert into ${sql.unsafe(schema)}.oauth_account
            (identity_id, provider, provider_account_id, email, access_token, refresh_token, encryption_key_id, token_expires_at)
          values (${identityId}, ${provider}, ${providerAccountId}, ${email ?? null}, ${encryptedAccess}, ${encryptedRefresh}, ${keyId}, ${tokenExpiresAt ?? null})
          on conflict (provider, provider_account_id)
          do update set
            identity_id = excluded.identity_id,
            email = excluded.email,
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            encryption_key_id = excluded.encryption_key_id,
            token_expires_at = excluded.token_expires_at,
            updated_at = now()
          returning id, identity_id, provider, provider_account_id, email, access_token, refresh_token, encryption_key_id, token_expires_at, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to link OAuth account");
        }
        return rowToOAuthAccount(row);
      });
    },

    async getOAuthAccount(
      provider: OAuthProvider,
      providerAccountId: string,
    ): Promise<OAuthAccount | null> {
      return withTx(ctx, "getOAuthAccount", async (sql) => {
        const [row] = await sql<OAuthAccountRow[]>`
          select id, identity_id, provider, provider_account_id, email, access_token, refresh_token, encryption_key_id, token_expires_at, created_at, updated_at
          from ${sql.unsafe(schema)}.oauth_account
          where provider = ${provider} and provider_account_id = ${providerAccountId}
        `;
        return row ? rowToOAuthAccount(row) : null;
      });
    },

    async getOAuthAccountsByIdentity(
      identityId: string,
    ): Promise<OAuthAccount[]> {
      return withTx(ctx, "getOAuthAccountsByIdentity", async (sql) => {
        const rows = await sql<OAuthAccountRow[]>`
          select id, identity_id, provider, provider_account_id, email, access_token, refresh_token, encryption_key_id, token_expires_at, created_at, updated_at
          from ${sql.unsafe(schema)}.oauth_account
          where identity_id = ${identityId}
          order by created_at
        `;
        return rows.map(rowToOAuthAccount);
      });
    },

    async unlinkOAuthAccount(id: string): Promise<boolean> {
      return withTx(ctx, "unlinkOAuthAccount", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.oauth_account
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async refreshOAuthTokens(
      id: string,
      params: {
        accessToken: string;
        refreshToken?: string;
        tokenExpiresAt?: Date;
      },
    ): Promise<boolean> {
      const { accessToken, refreshToken, tokenExpiresAt } = params;

      const { ciphertext: encryptedAccess, keyId } =
        await crypto.encrypt(accessToken);
      const encryptedRefresh = refreshToken
        ? (await crypto.encrypt(refreshToken)).ciphertext
        : undefined;

      return withTx(ctx, "refreshOAuthTokens", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.oauth_account
          set
            access_token = ${encryptedAccess},
            ${encryptedRefresh !== undefined ? sql`refresh_token = ${encryptedRefresh},` : sql``}
            encryption_key_id = ${keyId},
            ${tokenExpiresAt !== undefined ? sql`token_expires_at = ${tokenExpiresAt},` : sql``}
            updated_at = now()
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async getOAuthTokens(
      id: string,
    ): Promise<{ accessToken: string; refreshToken: string | null } | null> {
      return withTx(ctx, "getOAuthTokens", async (sql) => {
        const [row] = await sql<OAuthAccountRow[]>`
          select access_token, refresh_token, encryption_key_id
          from ${sql.unsafe(schema)}.oauth_account
          where id = ${id}
        `;

        if (!row || !row.access_token || !row.encryption_key_id) {
          return null;
        }

        const accessToken = await crypto.decrypt(
          row.access_token,
          row.encryption_key_id,
        );
        const refreshToken = row.refresh_token
          ? await crypto.decrypt(row.refresh_token, row.encryption_key_id)
          : null;

        return { accessToken, refreshToken };
      });
    },
  };
}

export type OAuthOps = ReturnType<typeof oauthOps>;
