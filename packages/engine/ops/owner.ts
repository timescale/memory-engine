import type { OpsContext, TreeOwner } from "../types";
import { withTx } from "./_tx";

// Row type from database
interface TreeOwnerRow {
  tree_path: string;
  user_id: string;
  created_by: string | null;
  created_at: Date;
}

function rowToTreeOwner(row: TreeOwnerRow): TreeOwner {
  return {
    treePath: row.tree_path,
    userId: row.user_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function ownerOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Set tree owner (upserts on tree_path)
     */
    async setTreeOwner(
      userId: string,
      treePath: string,
      createdBy?: string,
    ): Promise<void> {
      await withTx(ctx, "admin", "setTreeOwner", async (sql) => {
        await sql`
          insert into ${sql.unsafe(schema)}.tree_owner
            (tree_path, user_id, created_by)
          values
            (${treePath}::ltree, ${userId}, ${createdBy ?? null})
          on conflict (tree_path)
          do update set
            user_id = excluded.user_id,
            created_by = excluded.created_by
        `;
      });
    },

    /**
     * Remove tree owner
     */
    async removeTreeOwner(treePath: string): Promise<boolean> {
      return withTx(ctx, "admin", "removeTreeOwner", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.tree_owner
          where tree_path = ${treePath}::ltree
        `;
        return result.count > 0;
      });
    },

    /**
     * Get tree owner by path
     */
    async getTreeOwner(treePath: string): Promise<TreeOwner | null> {
      return withTx(ctx, "admin", "getTreeOwner", async (sql) => {
        const rows = await sql<TreeOwnerRow[]>`
          select tree_path::text, user_id, created_by, created_at
          from ${sql.unsafe(schema)}.tree_owner
          where tree_path = ${treePath}::ltree
        `;
        const row = rows[0];
        return row ? rowToTreeOwner(row) : null;
      });
    },

    /**
     * List tree owners, optionally filtered by user
     */
    async listTreeOwners(userId?: string): Promise<TreeOwner[]> {
      return withTx(ctx, "admin", "listTreeOwners", async (sql) => {
        if (userId) {
          const rows = await sql<TreeOwnerRow[]>`
            select tree_path::text, user_id, created_by, created_at
            from ${sql.unsafe(schema)}.tree_owner
            where user_id = ${userId}
            order by tree_path
          `;
          return rows.map(rowToTreeOwner);
        }

        const rows = await sql<TreeOwnerRow[]>`
          select tree_path::text, user_id, created_by, created_at
          from ${sql.unsafe(schema)}.tree_owner
          order by tree_path
        `;
        return rows.map(rowToTreeOwner);
      });
    },

    /**
     * Check if a user owns a tree path (or any ancestor)
     */
    async isOwnerOf(userId: string, treePath: string): Promise<boolean> {
      return withTx(ctx, "admin", "isOwnerOf", async (sql) => {
        const rows = await sql<{ is_owner: boolean }[]>`
          select exists (
            select 1
            from ${sql.unsafe(schema)}.tree_owner
            where user_id = ${userId}
              and ${treePath}::ltree <@ tree_path
          ) as is_owner
        `;
        return rows[0]?.is_owner ?? false;
      });
    },
  };
}

export type OwnerOps = ReturnType<typeof ownerOps>;
