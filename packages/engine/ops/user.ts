import type { CreateUserParams, OpsContext, User } from "../types";
import { withTx } from "./_tx";

// Row type from database
interface UserRow {
  id: string;
  name: string;
  identity_id: string | null;
  can_login: boolean;
  superuser: boolean;
  createrole: boolean;
  created_at: Date;
  updated_at: Date | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    identityId: row.identity_id,
    canLogin: row.can_login,
    superuser: row.superuser,
    createrole: row.createrole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function userOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Create a new user
     */
    async createUser(params: CreateUserParams): Promise<User> {
      const {
        id,
        name,
        identityId = null,
        canLogin = true,
        superuser = false,
        createrole = false,
      } = params;

      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<UserRow[]>`
          insert into ${sql.unsafe(schema)}."user"
            (id, name, identity_id, can_login, superuser, createrole)
          values
            (${id ? sql`${id}::uuid` : sql`uuidv7()`}, ${name}, ${identityId}, ${canLogin}, ${superuser}, ${createrole})
          returning id, name, identity_id, can_login, superuser, createrole, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create user");
        }
        return rowToUser(row);
      });
    },

    /**
     * Create a role (user with can_login = false)
     */
    async createRole(name: string, identityId?: string | null): Promise<User> {
      return this.createUser({
        name,
        identityId,
        canLogin: false,
        superuser: false,
      });
    },

    /**
     * Create a superuser
     */
    async createSuperuser(
      name: string,
      id?: string,
      identityId?: string | null,
    ): Promise<User> {
      return this.createUser({
        id,
        name,
        identityId,
        canLogin: true,
        superuser: true,
      });
    },

    /**
     * Get a user by ID
     */
    async getUser(id: string): Promise<User | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<UserRow[]>`
          select id, name, identity_id, can_login, superuser, createrole, created_at, updated_at
          from ${sql.unsafe(schema)}."user"
          where id = ${id}
        `;
        return row ? rowToUser(row) : null;
      });
    },

    /**
     * Get a user by name
     */
    async getUserByName(name: string): Promise<User | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<UserRow[]>`
          select id, name, identity_id, can_login, superuser, createrole, created_at, updated_at
          from ${sql.unsafe(schema)}."user"
          where name = ${name}
        `;
        return row ? rowToUser(row) : null;
      });
    },

    /**
     * List all users (optionally filter by can_login)
     */
    async listUsers(canLogin?: boolean): Promise<User[]> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<UserRow[]>`
          select id, name, identity_id, can_login, superuser, createrole, created_at, updated_at
          from ${sql.unsafe(schema)}."user"
          ${canLogin !== undefined ? sql`where can_login = ${canLogin}` : sql``}
          order by created_at
        `;
        return rows.map(rowToUser);
      });
    },

    /**
     * List users linked to a specific identity
     */
    async listUsersByIdentity(identityId: string): Promise<User[]> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<UserRow[]>`
          select id, name, identity_id, can_login, superuser, createrole, created_at, updated_at
          from ${sql.unsafe(schema)}."user"
          where identity_id = ${identityId}
          order by created_at
        `;
        return rows.map(rowToUser);
      });
    },

    /**
     * Find a user by identity ID (returns first match or null)
     */
    async getUserByIdentity(identityId: string): Promise<User | null> {
      return withTx(ctx, "admin", async (sql) => {
        const [row] = await sql<UserRow[]>`
          select id, name, identity_id, can_login, superuser, createrole, created_at, updated_at
          from ${sql.unsafe(schema)}."user"
          where identity_id = ${identityId}
          limit 1
        `;
        return row ? rowToUser(row) : null;
      });
    },

    /**
     * Rename a user
     */
    async renameUser(id: string, newName: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}."user"
          set name = ${newName}
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    /**
     * Delete a user
     */
    async deleteUser(id: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}."user"
          where id = ${id}
        `;
        return result.count > 0;
      });
    },
  };
}

export type UserOps = ReturnType<typeof userOps>;
