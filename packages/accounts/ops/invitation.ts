import type {
  AccountsContext,
  CreateInvitationParams,
  CreateInvitationResult,
  Invitation,
  OrgRole,
} from "../types";
import { generateToken, tokenHash } from "../util/hash";
import { withTx } from "./_tx";

interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: OrgRole;
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
      const hash = tokenHash(rawToken);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      return withTx(ctx, "createInvitation", async (sql) => {
        // Upsert: replace existing pending invitation for same org+email
        const rows = await sql<InvitationRow[]>`
          insert into ${sql.unsafe(schema)}.invitation
            (org_id, email, role, token_hash, invited_by, expires_at)
          values (${orgId}, ${email}, ${role}, ${hash}, ${invitedBy}, ${expiresAt})
          on conflict (org_id, email)
          do update set
            role = excluded.role,
            token_hash = excluded.token_hash,
            invited_by = excluded.invited_by,
            expires_at = excluded.expires_at,
            accepted_at = null
          returning id, org_id, email, role, invited_by, expires_at, accepted_at, created_at
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
      const hash = tokenHash(rawToken);

      return withTx(ctx, "getInvitationByToken", async (sql) => {
        // Single indexed lookup on the partial unique index:
        //   invitation_token_hash_uniq (token_hash) where accepted_at is null.
        const rows = await sql<InvitationRow[]>`
          select id, org_id, email, role, invited_by, expires_at, accepted_at, created_at
          from ${sql.unsafe(schema)}.invitation
          where token_hash = ${hash}
            and accepted_at is null
            and expires_at > now()
          limit 1
        `;
        const row = rows[0];
        return row ? rowToInvitation(row) : null;
      });
    },

    async acceptInvitation(id: string): Promise<Invitation | null> {
      return withTx(ctx, "acceptInvitation", async (sql) => {
        const rows = await sql<InvitationRow[]>`
          update ${sql.unsafe(schema)}.invitation
          set accepted_at = now()
          where id = ${id}
            and accepted_at is null
          returning id, org_id, email, role, invited_by, expires_at, accepted_at, created_at
        `;
        const row = rows[0];
        return row ? rowToInvitation(row) : null;
      });
    },

    async revokeInvitation(id: string): Promise<boolean> {
      return withTx(ctx, "revokeInvitation", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.invitation
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async listPendingInvitations(orgId: string): Promise<Invitation[]> {
      return withTx(ctx, "listPendingInvitations", async (sql) => {
        const rows = await sql<InvitationRow[]>`
          select id, org_id, email, role, invited_by, expires_at, accepted_at, created_at
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
