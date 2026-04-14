import type { OpsContext, RoleInfo, RoleMember } from "../types";
import { withTx } from "./_tx";

// Row type from database
interface RoleMemberRow {
  role_id: string;
  member_id: string;
  member_name: string;
  with_admin_option: boolean;
  created_at: Date;
}

interface RoleInfoRow {
  id: string;
  name: string;
  with_admin_option: boolean;
}

function rowToRoleMember(row: RoleMemberRow): RoleMember {
  return {
    roleId: row.role_id,
    memberId: row.member_id,
    memberName: row.member_name,
    withAdminOption: row.with_admin_option,
    createdAt: row.created_at,
  };
}

function rowToRoleInfo(row: RoleInfoRow): RoleInfo {
  return {
    id: row.id,
    name: row.name,
    withAdminOption: row.with_admin_option,
  };
}

export function roleOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Add a member to a role (with cycle detection)
     */
    async addRoleMember(
      roleId: string,
      memberId: string,
      withAdminOption = false,
    ): Promise<void> {
      await withTx(ctx, "admin", "addRoleMember", async (sql) => {
        // Check for cycles first
        const cycleRows = await sql<{ would_cycle: boolean }[]>`
          select ${sql.unsafe(schema)}.would_create_cycle(
            ${roleId}::uuid,
            ${memberId}::uuid
          ) as would_cycle
        `;

        if (cycleRows[0]?.would_cycle) {
          throw new Error(
            `Adding member ${memberId} to role ${roleId} would create a cycle`,
          );
        }

        await sql`
          insert into ${sql.unsafe(schema)}.role_membership
            (role_id, member_id, with_admin_option)
          values
            (${roleId}, ${memberId}, ${withAdminOption})
          on conflict (role_id, member_id)
          do update set
            with_admin_option = excluded.with_admin_option
        `;
      });
    },

    /**
     * Remove a member from a role
     */
    async removeRoleMember(roleId: string, memberId: string): Promise<boolean> {
      return withTx(ctx, "admin", "removeRoleMember", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.role_membership
          where role_id = ${roleId}
            and member_id = ${memberId}
        `;
        return result.count > 0;
      });
    },

    /**
     * List members of a role
     */
    async listRoleMembers(roleId: string): Promise<RoleMember[]> {
      return withTx(ctx, "admin", "listRoleMembers", async (sql) => {
        const rows = await sql<RoleMemberRow[]>`
          select rm.role_id, rm.member_id, u.name as member_name, rm.with_admin_option, rm.created_at
          from ${sql.unsafe(schema)}.role_membership rm
          join ${sql.unsafe(schema)}."user" u on u.id = rm.member_id
          where rm.role_id = ${roleId}
          order by rm.created_at
        `;
        return rows.map(rowToRoleMember);
      });
    },

    /**
     * List roles that a user is a member of
     */
    async listRolesForUser(userId: string): Promise<RoleInfo[]> {
      return withTx(ctx, "admin", "listRolesForUser", async (sql) => {
        const rows = await sql<RoleInfoRow[]>`
          select u.id, u.name, rm.with_admin_option
          from ${sql.unsafe(schema)}.role_membership rm
          join ${sql.unsafe(schema)}."user" u on u.id = rm.role_id
          where rm.member_id = ${userId}
          order by u.name
        `;
        return rows.map(rowToRoleInfo);
      });
    },

    /**
     * Check if a user has admin option on a role
     */
    async hasAdminOption(userId: string, roleId: string): Promise<boolean> {
      return withTx(ctx, "admin", "hasAdminOption", async (sql) => {
        const rows = await sql<{ has_admin: boolean }[]>`
          select exists (
            select 1
            from ${sql.unsafe(schema)}.role_membership
            where role_id = ${roleId}
              and member_id = ${userId}
              and with_admin_option = true
          ) as has_admin
        `;
        return rows[0]?.has_admin ?? false;
      });
    },
  };
}

export type RoleOps = ReturnType<typeof roleOps>;
