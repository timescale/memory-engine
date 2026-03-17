import type { CreatePrincipalParams, OpsContext, Principal } from "../types";
import { hashPassword } from "../util/password";
import { withTx } from "./_tx";

// Row type from database
interface PrincipalRow {
  id: string;
  email: string | null;
  name: string;
  superuser: boolean;
  createrole: boolean;
  can_login: boolean;
  created_at: Date;
  updated_at: Date | null;
}

function rowToPrincipal(row: PrincipalRow): Principal {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    superuser: row.superuser,
    createrole: row.createrole,
    canLogin: row.can_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function principalOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Create a new principal
     */
    async createPrincipal(params: CreatePrincipalParams): Promise<Principal> {
      const {
        name,
        email = null,
        password = null,
        superuser = false,
        createrole = false,
        canLogin = true,
      } = params;

      const passwordHash = password ? await hashPassword(password) : null;

      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<PrincipalRow[]>`
          insert into ${sql.unsafe(schema)}.principal
            (name, email, password_hash, superuser, createrole, can_login)
          values
            (${name}, ${email}, ${passwordHash}, ${superuser}, ${createrole}, ${canLogin})
          returning id, email, name, superuser, createrole, can_login, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create principal");
        }
        return rowToPrincipal(row);
      });
    },

    /**
     * Create a superuser principal (convenience method for provisioning)
     */
    async createSuperuser(
      name: string,
      email?: string,
      password?: string,
    ): Promise<Principal> {
      return this.createPrincipal({
        name,
        email,
        password,
        superuser: true,
        createrole: true,
        canLogin: true,
      });
    },

    /**
     * Register a new user with email and password
     */
    async register(
      email: string,
      password: string,
      name: string,
    ): Promise<Principal> {
      return this.createPrincipal({
        name,
        email,
        password,
        superuser: false,
        createrole: false,
        canLogin: true,
      });
    },

    /**
     * Get a principal by ID
     */
    async getPrincipal(id: string): Promise<Principal | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<PrincipalRow[]>`
          select id, email, name, superuser, createrole, can_login, created_at, updated_at
          from ${sql.unsafe(schema)}.principal
          where id = ${id}
        `;
        return row ? rowToPrincipal(row) : null;
      });
    },

    /**
     * Get a principal by name (case-insensitive via citext)
     */
    async getPrincipalByName(name: string): Promise<Principal | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<PrincipalRow[]>`
          select id, email, name, superuser, createrole, can_login, created_at, updated_at
          from ${sql.unsafe(schema)}.principal
          where name = ${name}
        `;
        return row ? rowToPrincipal(row) : null;
      });
    },

    /**
     * Get a principal by email (case-insensitive via citext)
     */
    async getPrincipalByEmail(email: string): Promise<Principal | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<PrincipalRow[]>`
          select id, email, name, superuser, createrole, can_login, created_at, updated_at
          from ${sql.unsafe(schema)}.principal
          where email = ${email}
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
          select id, email, name, superuser, createrole, can_login, created_at, updated_at
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

    /**
     * Set password for a principal
     */
    async setPassword(principalId: string, password: string): Promise<void> {
      const passwordHash = await hashPassword(password);

      await withTx(ctx, "admin", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.principal
          set password_hash = ${passwordHash}
          where id = ${principalId}
        `;
        if (result.count === 0) {
          throw new Error(`Principal not found: ${principalId}`);
        }
      });
    },
  };
}

export type PrincipalOps = ReturnType<typeof principalOps>;
