import type { GrantTreeAccessParams, OpsContext, TreeGrant } from "../types";
import { withTx } from "./_tx";

// Row type from database
interface TreeGrantRow {
  id: string;
  user_id: string;
  tree_path: string;
  actions: string[];
  granted_by: string | null;
  with_grant_option: boolean;
  created_at: Date;
}

function rowToTreeGrant(row: TreeGrantRow): TreeGrant {
  return {
    id: row.id,
    userId: row.user_id,
    treePath: row.tree_path,
    actions: row.actions,
    grantedBy: row.granted_by,
    withGrantOption: row.with_grant_option,
    createdAt: row.created_at,
  };
}

export function grantOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Grant tree access to a user (upserts on user_id + tree_path)
     */
    async grantTreeAccess(params: GrantTreeAccessParams): Promise<void> {
      const {
        userId,
        treePath,
        actions,
        grantedBy = null,
        withGrantOption = false,
      } = params;

      await withTx(ctx, "admin", async (sql) => {
        // Format actions as PostgreSQL array literal
        const actionsArray = `{${actions.join(",")}}`;
        await sql`
          insert into ${sql.unsafe(schema)}.tree_grant
            (user_id, tree_path, actions, granted_by, with_grant_option)
          values
            (${userId}, ${treePath}::ltree, ${actionsArray}::text[], ${grantedBy}, ${withGrantOption})
          on conflict (user_id, tree_path)
          do update set
            actions = excluded.actions,
            granted_by = excluded.granted_by,
            with_grant_option = excluded.with_grant_option
        `;
      });
    },

    /**
     * Revoke tree access from a user
     */
    async revokeTreeAccess(userId: string, treePath: string): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.tree_grant
          where user_id = ${userId}
            and tree_path = ${treePath}::ltree
        `;
        return result.count > 0;
      });
    },

    /**
     * List tree grants, optionally filtered by user
     */
    async listTreeGrants(userId?: string): Promise<TreeGrant[]> {
      return withTx(ctx, "admin", async (sql) => {
        if (userId) {
          const rows = await sql<TreeGrantRow[]>`
            select id, user_id, tree_path::text, actions, granted_by, with_grant_option, created_at
            from ${sql.unsafe(schema)}.tree_grant
            where user_id = ${userId}
            order by tree_path
          `;
          return rows.map(rowToTreeGrant);
        }

        const rows = await sql<TreeGrantRow[]>`
          select id, user_id, tree_path::text, actions, granted_by, with_grant_option, created_at
          from ${sql.unsafe(schema)}.tree_grant
          order by user_id, tree_path
        `;
        return rows.map(rowToTreeGrant);
      });
    },

    /**
     * Get a specific grant by user and tree path
     */
    async getTreeGrant(
      userId: string,
      treePath: string,
    ): Promise<TreeGrant | null> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<TreeGrantRow[]>`
          select id, user_id, tree_path::text, actions, granted_by, with_grant_option, created_at
          from ${sql.unsafe(schema)}.tree_grant
          where user_id = ${userId}
            and tree_path = ${treePath}::ltree
        `;
        const row = rows[0];
        return row ? rowToTreeGrant(row) : null;
      });
    },

    /**
     * Check if a user has access to a tree path for a given action
     * Uses the database's tree_access function (includes role inheritance)
     */
    async checkTreeAccess(
      userId: string,
      treePath: string,
      action: string,
    ): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const rows = await sql<{ allowed: boolean }[]>`
          select exists(
            select 1
            from ${sql.unsafe(schema)}.tree_access(
              ${userId}::uuid,
              ${action}
            ) ta(tree_path)
            where ${treePath}::ltree <@ ta.tree_path
          ) as allowed
        `;
        return rows[0]?.allowed ?? false;
      });
    },

    /**
     * Check if a user has grant option for a tree path and actions
     */
    async hasGrantOption(
      userId: string,
      treePath: string,
      actions: string[],
    ): Promise<boolean> {
      return withTx(ctx, "admin", async (sql) => {
        const actionsArray = `{${actions.join(",")}}`;
        const rows = await sql<{ has_option: boolean }[]>`
          select exists (
            select 1
            from ${sql.unsafe(schema)}.tree_grant
            where user_id = ${userId}
              and ${treePath}::ltree <@ tree_path
              and with_grant_option = true
              and actions @> ${actionsArray}::text[]
          ) as has_option
        `;
        return rows[0]?.has_option ?? false;
      });
    },
  };
}

export type GrantOps = ReturnType<typeof grantOps>;
