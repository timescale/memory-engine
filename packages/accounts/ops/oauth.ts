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
  const { schema } = ctx;

  return {
    // Login-only: we use the provider access token once during the OAuth
    // callback to fetch the user's identity, then discard it. No provider
    // tokens are persisted, so there is nothing to encrypt at rest.
    async linkOAuthAccount(params: LinkOAuthParams): Promise<OAuthAccount> {
      const { identityId, provider, providerAccountId, email } = params;

      return withTx(ctx, "linkOAuthAccount", async (sql) => {
        const rows = await sql<OAuthAccountRow[]>`
          insert into ${sql.unsafe(schema)}.oauth_account
            (identity_id, provider, provider_account_id, email)
          values (${identityId}, ${provider}, ${providerAccountId}, ${email ?? null})
          on conflict (provider, provider_account_id)
          do update set
            identity_id = excluded.identity_id,
            email = excluded.email,
            updated_at = now()
          returning id, identity_id, provider, provider_account_id, email, created_at, updated_at
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
          select id, identity_id, provider, provider_account_id, email, created_at, updated_at
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
          select id, identity_id, provider, provider_account_id, email, created_at, updated_at
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
  };
}

export type OAuthOps = ReturnType<typeof oauthOps>;
