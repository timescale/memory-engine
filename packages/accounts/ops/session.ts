import type {
  AccountsContext,
  CreateSessionParams,
  CreateSessionResult,
  Identity,
  Session,
} from "../types";
import { generateToken, hashToken, verifyToken } from "../util/hash";
import { withTx } from "./_tx";

interface SessionRow {
  id: string;
  identity_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

interface SessionWithIdentityRow extends SessionRow {
  identity_email: string;
  identity_name: string;
  identity_created_at: Date;
  identity_updated_at: Date | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    identityId: row.identity_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function sessionOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    async createSession(
      params: CreateSessionParams,
    ): Promise<CreateSessionResult> {
      const { identityId, expiresInDays = 30 } = params;

      const rawToken = generateToken();
      const tokenHash = await hashToken(rawToken);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      return withTx(ctx, async (sql) => {
        const rows = await sql<SessionRow[]>`
          insert into ${sql.unsafe(schema)}.session (identity_id, token, expires_at)
          values (${identityId}, ${tokenHash}, ${expiresAt})
          returning id, identity_id, token, expires_at, created_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create session");
        }
        return {
          session: rowToSession(row),
          rawToken,
        };
      });
    },

    async validateSession(
      rawToken: string,
    ): Promise<{ session: Session; identity: Identity } | null> {
      return withTx(ctx, async (sql) => {
        // Get all non-expired sessions and verify token against each
        const rows = await sql<SessionWithIdentityRow[]>`
          select
            s.id, s.identity_id, s.token, s.expires_at, s.created_at,
            i.email as identity_email, i.name as identity_name,
            i.created_at as identity_created_at, i.updated_at as identity_updated_at
          from ${sql.unsafe(schema)}.session s
          inner join ${sql.unsafe(schema)}.identity i on i.id = s.identity_id
          where s.expires_at > now()
        `;

        for (const row of rows) {
          const valid = await verifyToken(rawToken, row.token);
          if (valid) {
            return {
              session: rowToSession(row),
              identity: {
                id: row.identity_id,
                email: row.identity_email,
                name: row.identity_name,
                createdAt: row.identity_created_at,
                updatedAt: row.identity_updated_at,
              },
            };
          }
        }

        return null;
      });
    },

    async deleteSession(id: string): Promise<boolean> {
      return withTx(ctx, async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.session
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async deleteSessionsByIdentity(identityId: string): Promise<number> {
      return withTx(ctx, async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.session
          where identity_id = ${identityId}
        `;
        return result.count;
      });
    },

    async cleanupExpiredSessions(): Promise<number> {
      return withTx(ctx, async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.session
          where expires_at <= now()
        `;
        return result.count;
      });
    },
  };
}

export type SessionOps = ReturnType<typeof sessionOps>;
