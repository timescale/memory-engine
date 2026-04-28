import {
  type AccountsContext,
  AccountsError,
  type OrgMember,
  type OrgRole,
} from "../types";
import { withTx } from "./_tx";

interface OrgMemberRow {
  org_id: string;
  identity_id: string;
  role: OrgRole;
  created_at: Date;
  name: string;
  email: string;
}

function rowToOrgMember(row: OrgMemberRow): OrgMember {
  return {
    orgId: row.org_id,
    identityId: row.identity_id,
    role: row.role,
    createdAt: row.created_at,
    name: row.name,
    email: row.email,
  };
}

/**
 * Verify that removing or demoting `identityId` from `orgId` would leave at
 * least one other owner in place. Throws ORG_MUST_HAVE_OWNER otherwise.
 *
 * The query takes `for update` row locks on every other owner row in the
 * org. This closes the race where two concurrent transactions, each
 * removing a different owner, both observe the other's row as still
 * present and proceed — leaving the org with zero owners. With `for
 * update`, the second transaction blocks on the first's row locks, sees
 * the post-commit count, and correctly fails. The previous DB trigger
 * had the same race; this hardens it.
 */
async function assertAnotherOwnerExists(
  sql: import("bun").SQL,
  schema: string,
  orgId: string,
  identityId: string,
): Promise<void> {
  const rows = await sql<{ identity_id: string }[]>`
    select identity_id
    from ${sql.unsafe(schema)}.org_member
    where org_id = ${orgId}
      and role = 'owner'
      and identity_id <> ${identityId}
    for update
  `;
  if (rows.length === 0) {
    throw new AccountsError(
      "ORG_MUST_HAVE_OWNER",
      "Cannot remove the last owner from an organization",
    );
  }
}

export function orgMemberOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    async addMember(
      orgId: string,
      identityId: string,
      role: OrgRole,
    ): Promise<OrgMember> {
      return withTx(ctx, "addMember", async (sql) => {
        const rows = await sql<OrgMemberRow[]>`
          with inserted as (
            insert into ${sql.unsafe(schema)}.org_member (org_id, identity_id, role)
            values (${orgId}, ${identityId}, ${role})
            returning org_id, identity_id, role, created_at
          )
          select i.*, id.name, id.email
          from inserted i
          join ${sql.unsafe(schema)}.identity id on id.id = i.identity_id
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to add member");
        }
        return rowToOrgMember(row);
      });
    },

    async removeMember(orgId: string, identityId: string): Promise<boolean> {
      return withTx(ctx, "removeMember", async (sql) => {
        // Fetch the target row with `for update` so the row stays stable
        // under our feet while we decide whether to delete it.
        const [target] = await sql<{ role: OrgRole }[]>`
          select role
          from ${sql.unsafe(schema)}.org_member
          where org_id = ${orgId} and identity_id = ${identityId}
          for update
        `;
        if (!target) return false;

        if (target.role === "owner") {
          await assertAnotherOwnerExists(sql, schema, orgId, identityId);
        }

        const result = await sql`
          delete from ${sql.unsafe(schema)}.org_member
          where org_id = ${orgId} and identity_id = ${identityId}
        `;
        return result.count > 0;
      });
    },

    async updateRole(
      orgId: string,
      identityId: string,
      newRole: OrgRole,
    ): Promise<boolean> {
      return withTx(ctx, "updateRole", async (sql) => {
        const [target] = await sql<{ role: OrgRole }[]>`
          select role
          from ${sql.unsafe(schema)}.org_member
          where org_id = ${orgId} and identity_id = ${identityId}
          for update
        `;
        if (!target) return false;

        // Only block the transition that would orphan the org: an owner
        // being changed to anything other than owner.
        if (target.role === "owner" && newRole !== "owner") {
          await assertAnotherOwnerExists(sql, schema, orgId, identityId);
        }

        const result = await sql`
          update ${sql.unsafe(schema)}.org_member
          set role = ${newRole}
          where org_id = ${orgId} and identity_id = ${identityId}
        `;
        return result.count > 0;
      });
    },

    async getMember(
      orgId: string,
      identityId: string,
    ): Promise<OrgMember | null> {
      return withTx(ctx, "getMember", async (sql) => {
        const [row] = await sql<OrgMemberRow[]>`
          select m.org_id, m.identity_id, m.role, m.created_at, id.name, id.email
          from ${sql.unsafe(schema)}.org_member m
          join ${sql.unsafe(schema)}.identity id on id.id = m.identity_id
          where m.org_id = ${orgId} and m.identity_id = ${identityId}
        `;
        return row ? rowToOrgMember(row) : null;
      });
    },

    async listMembers(orgId: string): Promise<OrgMember[]> {
      return withTx(ctx, "listMembers", async (sql) => {
        const rows = await sql<OrgMemberRow[]>`
          select m.org_id, m.identity_id, m.role, m.created_at, id.name, id.email
          from ${sql.unsafe(schema)}.org_member m
          join ${sql.unsafe(schema)}.identity id on id.id = m.identity_id
          where m.org_id = ${orgId}
          order by m.created_at
        `;
        return rows.map(rowToOrgMember);
      });
    },

    async countOwnedOrgs(identityId: string): Promise<number> {
      return withTx(ctx, "countOwnedOrgs", async (sql) => {
        const [row] = await sql<{ count: number }[]>`
          select count(*)::int as count
          from ${sql.unsafe(schema)}.org_member
          where identity_id = ${identityId} and role = 'owner'
        `;
        return row?.count ?? 0;
      });
    },

    async listOwners(orgId: string): Promise<OrgMember[]> {
      return withTx(ctx, "listOwners", async (sql) => {
        const rows = await sql<OrgMemberRow[]>`
          select m.org_id, m.identity_id, m.role, m.created_at, id.name, id.email
          from ${sql.unsafe(schema)}.org_member m
          join ${sql.unsafe(schema)}.identity id on id.id = m.identity_id
          where m.org_id = ${orgId} and m.role = 'owner'
          order by m.created_at
        `;
        return rows.map(rowToOrgMember);
      });
    },
  };
}

export type OrgMemberOps = ReturnType<typeof orgMemberOps>;
