import type { AccountsContext, CreateIdentityParams, Identity } from "../types";
import { withTx } from "./_tx";

interface IdentityRow {
  id: string;
  email: string;
  name: string;
  created_at: Date;
  updated_at: Date | null;
}

function rowToIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function identityOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    async createIdentity(params: CreateIdentityParams): Promise<Identity> {
      const { id, email, name } = params;

      return withTx(ctx, async (sql) => {
        const rows = await sql<IdentityRow[]>`
          insert into ${sql.unsafe(schema)}.identity (id, email, name)
          values (${id ? sql`${id}::uuid` : sql`uuidv7()`}, ${email}, ${name})
          returning id, email, name, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create identity");
        }
        return rowToIdentity(row);
      });
    },

    async getIdentity(id: string): Promise<Identity | null> {
      return withTx(ctx, async (sql) => {
        const [row] = await sql<IdentityRow[]>`
          select id, email, name, created_at, updated_at
          from ${sql.unsafe(schema)}.identity
          where id = ${id}
        `;
        return row ? rowToIdentity(row) : null;
      });
    },

    async getIdentityByEmail(email: string): Promise<Identity | null> {
      return withTx(ctx, async (sql) => {
        const [row] = await sql<IdentityRow[]>`
          select id, email, name, created_at, updated_at
          from ${sql.unsafe(schema)}.identity
          where email = ${email}
        `;
        return row ? rowToIdentity(row) : null;
      });
    },

    async updateIdentity(
      id: string,
      params: { name?: string; email?: string },
    ): Promise<boolean> {
      const { name, email } = params;
      if (name === undefined && email === undefined) {
        return false;
      }

      return withTx(ctx, async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.identity
          set
            ${name !== undefined ? sql`name = ${name},` : sql``}
            ${email !== undefined ? sql`email = ${email},` : sql``}
            updated_at = now()
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async deleteIdentity(id: string): Promise<boolean> {
      return withTx(ctx, async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.identity
          where id = ${id}
        `;
        return result.count > 0;
      });
    },
  };
}

export type IdentityOps = ReturnType<typeof identityOps>;
