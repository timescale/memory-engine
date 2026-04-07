import type {
  AccountsContext,
  CreateInvitationParams,
  CreateInvitationResult,
  Invitation,
  OrgRole,
} from "../types";
import { generateToken, hashToken, verifyToken } from "../util/hash";
import { withTx } from "./_tx";

interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: OrgRole;
  token: string;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

function rowToInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  };
}

export function invitationOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    async createInvitation(
      params: CreateInvitationParams,
    ): Promise<CreateInvitationResult> {
      const { orgId, email, role, invitedBy, expiresInDays = 7 } = params;

      const rawToken = generateToken();
      const tokenHash = await hashToken(rawToken);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      return withTx(ctx, async (sql) => {
        // Upsert: replace existing pending invitation for same org+email
        const rows = await sql<InvitationRow[]>`
          insert into ${sql.unsafe(schema)}.invitation
            (org_id, email, role, token, invited_by, expires_at)
          values (${orgId}, ${email}, ${role}, ${tokenHash}, ${invitedBy}, ${expiresAt})
          on conflict (org_id, email)
          do update set
            role = excluded.role,
            token = excluded.token,
            invited_by = excluded.invited_by,
            expires_at = excluded.expires_at,
            accepted_at = null
          returning id, org_id, email, role, token, invited_by, expires_at, accepted_at, created_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create invitation");
        }
        return {
          invitation: rowToInvitation(row),
          rawToken,
        };
      });
    },

    async getInvitationByToken(rawToken: string): Promise<Invitation | null> {
      return withTx(ctx, async (sql) => {
        // Get all pending invitations and verify token against each
        // This is necessary because we can't query by hash directly
        const rows = await sql<InvitationRow[]>`
          select id, org_id, email, role, token, invited_by, expires_at, accepted_at, created_at
          from ${sql.unsafe(schema)}.invitation
          where accepted_at is null
            and expires_at > now()
        `;

        for (const row of rows) {
          const valid = await verifyToken(rawToken, row.token);
          if (valid) {
            return rowToInvitation(row);
          }
        }

        return null;
      });
    },

    async acceptInvitation(id: string): Promise<Invitation | null> {
      return withTx(ctx, async (sql) => {
        const rows = await sql<InvitationRow[]>`
          update ${sql.unsafe(schema)}.invitation
          set accepted_at = now()
          where id = ${id}
            and accepted_at is null
          returning id, org_id, email, role, token, invited_by, expires_at, accepted_at, created_at
        `;
        const row = rows[0];
        return row ? rowToInvitation(row) : null;
      });
    },

    async revokeInvitation(id: string): Promise<boolean> {
      return withTx(ctx, async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.invitation
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async listPendingInvitations(orgId: string): Promise<Invitation[]> {
      return withTx(ctx, async (sql) => {
        const rows = await sql<InvitationRow[]>`
          select id, org_id, email, role, token, invited_by, expires_at, accepted_at, created_at
          from ${sql.unsafe(schema)}.invitation
          where org_id = ${orgId}
            and accepted_at is null
            and expires_at > now()
          order by created_at
        `;
        return rows.map(rowToInvitation);
      });
    },
  };
}

export type InvitationOps = ReturnType<typeof invitationOps>;
