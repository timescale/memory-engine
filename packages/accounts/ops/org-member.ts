import {
  AccountsError,
  type AccountsContext,
  type OrgMember,
  type OrgRole,
} from "../types";
import { withTx } from "./_tx";

interface OrgMemberRow {
  org_id: string;
  identity_id: string;
  role: OrgRole;
  created_at: Date;
}

function rowToOrgMember(row: OrgMemberRow): OrgMember {
  return {
    orgId: row.org_id,
    identityId: row.identity_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

/**
 * Check if a PostgreSQL error is the "org_must_have_owner" trigger exception
 */
function isOrgOwnerError(err: unknown): boolean {
  return err instanceof Error && err.message?.includes("org_must_have_owner");
}

export function orgMemberOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    async addMember(
      orgId: string,
      identityId: string,
      role: OrgRole,
    ): Promise<OrgMember> {
      return withTx(ctx, async (sql) => {
        const rows = await sql<OrgMemberRow[]>`
          insert into ${sql.unsafe(schema)}.org_member (org_id, identity_id, role)
          values (${orgId}, ${identityId}, ${role})
          returning org_id, identity_id, role, created_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to add member");
        }
        return rowToOrgMember(row);
      });
    },

    async removeMember(orgId: string, identityId: string): Promise<boolean> {
      return withTx(ctx, async (sql) => {
        try {
          const result = await sql`
            delete from ${sql.unsafe(schema)}.org_member
            where org_id = ${orgId} and identity_id = ${identityId}
          `;
          return result.count > 0;
        } catch (err) {
          if (isOrgOwnerError(err)) {
            throw new AccountsError(
              "ORG_MUST_HAVE_OWNER",
              "Cannot remove the last owner from an organization",
            );
          }
          throw err;
        }
      });
    },

    async updateRole(
      orgId: string,
      identityId: string,
      newRole: OrgRole,
    ): Promise<boolean> {
      return withTx(ctx, async (sql) => {
        try {
          const result = await sql`
            update ${sql.unsafe(schema)}.org_member
            set role = ${newRole}
            where org_id = ${orgId} and identity_id = ${identityId}
          `;
          return result.count > 0;
        } catch (err) {
          if (isOrgOwnerError(err)) {
            throw new AccountsError(
              "ORG_MUST_HAVE_OWNER",
              "Cannot remove the last owner from an organization",
            );
          }
          throw err;
        }
      });
    },

    async getMember(
      orgId: string,
      identityId: string,
    ): Promise<OrgMember | null> {
      return withTx(ctx, async (sql) => {
        const [row] = await sql<OrgMemberRow[]>`
          select org_id, identity_id, role, created_at
          from ${sql.unsafe(schema)}.org_member
          where org_id = ${orgId} and identity_id = ${identityId}
        `;
        return row ? rowToOrgMember(row) : null;
      });
    },

    async listMembers(orgId: string): Promise<OrgMember[]> {
      return withTx(ctx, async (sql) => {
        const rows = await sql<OrgMemberRow[]>`
          select org_id, identity_id, role, created_at
          from ${sql.unsafe(schema)}.org_member
          where org_id = ${orgId}
          order by created_at
        `;
        return rows.map(rowToOrgMember);
      });
    },

    async listOwners(orgId: string): Promise<OrgMember[]> {
      return withTx(ctx, async (sql) => {
        const rows = await sql<OrgMemberRow[]>`
          select org_id, identity_id, role, created_at
          from ${sql.unsafe(schema)}.org_member
          where org_id = ${orgId} and role = 'owner'
          order by created_at
        `;
        return rows.map(rowToOrgMember);
      });
    },
  };
}

export type OrgMemberOps = ReturnType<typeof orgMemberOps>;
