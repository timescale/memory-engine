import type { CreatePrincipalParams, OpsContext, Principal } from "../types";
import { withTx } from "./_tx";

// Row type from database
interface PrincipalRow {
  id: string;
  name: string;
  superuser: boolean;
  created_at: Date;
  updated_at: Date | null;
}

function rowToPrincipal(row: PrincipalRow): Principal {
  return {
    id: row.id,
    name: row.name,
    superuser: row.superuser,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function principalOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Create a new principal (projection of accounts user/agent)
     * The ID should match the accounts user.id or agent.id
     */
    async createPrincipal(params: CreatePrincipalParams): Promise<Principal> {
      const { id, name, superuser = false } = params;

      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<PrincipalRow[]>`
          insert into ${sql.unsafe(schema)}.principal
            (id, name, superuser)
          values
            (${id ? sql`${id}::uuid` : sql`uuidv7()`}, ${name}, ${superuser})
          returning id, name, superuser, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create principal");
        }
        return rowToPrincipal(row);
      });
    },

    /**
     * Create or get a principal - used when projecting from accounts
     * If principal with this ID exists, returns it; otherwise creates it
     */
    async ensurePrincipal(
      id: string,
      name: string,
      superuser = false,
    ): Promise<Principal> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<PrincipalRow[]>`
          insert into ${sql.unsafe(schema)}.principal (id, name, superuser)
          values (${id}::uuid, ${name}, ${superuser})
          on conflict (id) do update set
            name = excluded.name,
            superuser = excluded.superuser
          returning id, name, superuser, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to ensure principal");
        }
        return rowToPrincipal(row);
      });
    },

    /**
     * Create a superuser principal (convenience method for provisioning)
     */
    async createSuperuser(name: string, id?: string): Promise<Principal> {
      return this.createPrincipal({
        id,
        name,
        superuser: true,
      });
    },

    /**
     * Get a principal by ID
     */
    async getPrincipal(id: string): Promise<Principal | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<PrincipalRow[]>`
          select id, name, superuser, created_at, updated_at
          from ${sql.unsafe(schema)}.principal
          where id = ${id}
        `;
        return row ? rowToPrincipal(row) : null;
      });
    },

    /**
     * Get a principal by name
     */
    async getPrincipalByName(name: string): Promise<Principal | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<PrincipalRow[]>`
          select id, name, superuser, created_at, updated_at
          from ${sql.unsafe(schema)}.principal
          where name = ${name}
        `;
        return row ? rowToPrincipal(row) : null;
      });
    },

    /**
     * List all principals
     */
    async listPrincipals(): Promise<Principal[]> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<PrincipalRow[]>`
          select id, name, superuser, created_at, updated_at
          from ${sql.unsafe(schema)}.principal
          order by created_at
        `;
        return rows.map(rowToPrincipal);
      });
    },

    /**
     * Rename a principal
     */
    async renamePrincipal(id: string, newName: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.principal
          set name = ${newName}
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    /**
     * Delete a principal
     */
    async deletePrincipal(id: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.principal
          where id = ${id}
        `;
        return result.count > 0;
      });
    },
  };
}

export type PrincipalOps = ReturnType<typeof principalOps>;
