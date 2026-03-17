import type { OpsContext, TreeOwner } from "../types";
import { withTx } from "./_tx";

// Row type from database
interface TreeOwnerRow {
  tree_path: string;
  principal_id: string;
  created_by: string | null;
  created_at: Date;
}

function rowToTreeOwner(row: TreeOwnerRow): TreeOwner {
  return {
    treePath: row.tree_path,
    principalId: row.principal_id,
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
      principalId: string,
      treePath: string,
      createdBy?: string,
    ): Promise<void> {
      await withTx(ctx, "admin", async (sql) => {
        await sql`
          insert into ${sql.unsafe(schema)}.tree_owner
            (tree_path, principal_id, created_by)
          values
            (${treePath}::ltree, ${principalId}, ${createdBy ?? null})
          on conflict (tree_path)
          do update set
            principal_id = excluded.principal_id,
            created_by = excluded.created_by
        `;
      });
    },

    /**
     * Remove tree owner
     */
    async removeTreeOwner(treePath: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
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
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<TreeOwnerRow[]>`
          select tree_path::text, principal_id, created_by, created_at
          from ${sql.unsafe(schema)}.tree_owner
          where tree_path = ${treePath}::ltree
        `;
        const row = rows[0];
        return row ? rowToTreeOwner(row) : null;
      });
    },

    /**
     * List tree owners, optionally filtered by principal
     */
    async listTreeOwners(principalId?: string): Promise<TreeOwner[]> {
      return withTx(ctx, "admin", async (sql) => {
        if (principalId) {
          const rows = await sql<TreeOwnerRow[]>`
            select tree_path::text, principal_id, created_by, created_at
            from ${sql.unsafe(schema)}.tree_owner
            where principal_id = ${principalId}
            order by tree_path
          `;
          return rows.map(rowToTreeOwner);
        }

        const rows = await sql<TreeOwnerRow[]>`
          select tree_path::text, principal_id, created_by, created_at
          from ${sql.unsafe(schema)}.tree_owner
          order by tree_path
        `;
        return rows.map(rowToTreeOwner);
      });
    },

    /**
     * Check if a principal owns a tree path (or any ancestor)
     */
    async isOwnerOf(principalId: string, treePath: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<{ is_owner: boolean }[]>`
          select exists (
            select 1
            from ${sql.unsafe(schema)}.tree_owner
            where principal_id = ${principalId}
              and ${treePath}::ltree <@ tree_path
          ) as is_owner
        `;
        return rows[0]?.is_owner ?? false;
      });
    },
  };
}

export type OwnerOps = ReturnType<typeof ownerOps>;
