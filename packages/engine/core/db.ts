import { CORE_SCHEMA } from "@memory.build/database";
import type { Sql } from "postgres";
import { generateLookupId, generateSecret, hashApiKeySecret } from "./api-key";
import { generateInviteToken } from "./invite-token";
import type {
  AccessLevel,
  ApiKeyInfo,
  CreatedApiKey,
  CreatedInvitation,
  Group,
  GroupMember,
  GroupMembership,
  MemberSpace,
  PendingInvitationForEmail,
  Principal,
  PrincipalKind,
  RedeemedInvitation,
  ServiceAccount,
  Space,
  SpaceInvitation,
  SpacePrincipal,
  TreeAccess,
  TreeGrant,
  ValidatedApiKey,
} from "./types";

/**
 * The core control-plane data layer.
 *
 * Thin wrappers over the core SQL functions — every method calls a function in
 * packages/database/core/migrate/idempotent/*.sql; none query core tables
 * directly. Access enforcement and multi-table logic live in the SQL.
 */
export interface CoreStore {
  createSpace(
    slug: string,
    name: string,
    opts?: { language?: string; autoGrantHome?: boolean },
  ): Promise<string>;
  getSpace(slug: string): Promise<Space | null>;
  /** All spaces (e.g. for the embedding worker to discover me_<slug> schemas). */
  listSpaces(): Promise<Space[]>;
  /** Spaces a member is a direct member of (principal_space), with admin flag. */
  listSpacesForMember(memberId: string): Promise<MemberSpace[]>;
  /** Rename a space (by slug). Returns true if it existed. */
  renameSpace(slug: string, name: string): Promise<boolean>;
  /**
   * Delete a space's core row (cascades memberships/groups/grants). The
   * me_<slug> data schema must be dropped separately. Returns true if it existed.
   */
  deleteSpace(slug: string): Promise<boolean>;

  createUser(id: string, name: string): Promise<string>;
  createAgent(ownerId: string, name: string, id?: string): Promise<string>;
  /**
   * Create a group, rostered into its space. `isSpaceAdmin` makes it an admin
   * group (its space-admin authority flows to direct-member users); defaults
   * false.
   */
  createGroup(
    spaceId: string,
    name: string,
    isSpaceAdmin?: boolean,
    id?: string,
  ): Promise<string>;
  /**
   * Provision a space's default group (rostered, non-admin, flagged
   * is_default_group), creating it if absent. `name` defaults to "team".
   * `grantDefaults` (default true) seeds read on `share` + write on
   * `share.projects`; pass false for a grantless default group the operator
   * configures by hand. Idempotent; returns the group id. Call inside the
   * space-creation transaction. The group starts memberless, so its grants are
   * dormant until a member is added.
   */
  provisionDefaultGroup(
    spaceId: string,
    name?: string,
    grantDefaults?: boolean,
  ): Promise<string>;
  getPrincipal(id: string): Promise<Principal | null>;
  /** Resolve a global user (kind 'u') by name (email). */
  getUserByName(name: string): Promise<Principal | null>;
  /** Rename an agent or group (never a user — its name is its identity email). */
  renamePrincipal(id: string, name: string): Promise<boolean>;
  deletePrincipal(id: string): Promise<boolean>;

  /** The space roster: principals with a direct (principal_space) membership. */
  listSpacePrincipals(
    spaceId: string,
    kind?: PrincipalKind,
  ): Promise<SpacePrincipal[]>;
  /** Whether a principal is an admin of a space (agents are never admins). */
  isSpaceAdmin(principalId: string, spaceId: string): Promise<boolean>;
  /** Whether a principal has a direct principal_space membership row. */
  isPrincipalInSpace(principalId: string, spaceId: string): Promise<boolean>;
  /** Whether a member is an admin of a group (agents are never group admins). */
  isGroupAdmin(
    memberId: string,
    groupId: string,
    spaceId: string,
  ): Promise<boolean>;
  /** Groups belonging to a space. */
  listSpaceGroups(spaceId: string): Promise<Group[]>;
  /**
   * Toggle a group's admin-group status (its own principal_space.admin).
   * Demotion is guarded by the space's last-admin safeguard. Returns true if the
   * group's roster row actually changed (a no-op toggle returns false).
   */
  setGroupIsSpaceAdmin(
    spaceId: string,
    groupId: string,
    isSpaceAdmin: boolean,
  ): Promise<boolean>;
  /** A user's agents (global; agents are owned by a user, not a space). */
  listAgents(ownerId: string): Promise<Principal[]>;

  addPrincipalToSpace(
    spaceId: string,
    principalId: string,
    admin?: boolean,
  ): Promise<void>;
  removePrincipalFromSpace(
    spaceId: string,
    principalId: string,
  ): Promise<boolean>;
  addGroupMember(
    spaceId: string,
    groupId: string,
    memberId: string,
    admin?: boolean,
  ): Promise<void>;
  removeGroupMember(
    spaceId: string,
    groupId: string,
    memberId: string,
  ): Promise<boolean>;
  /** Members (users / agents) of a group within a space. */
  listGroupMembers(spaceId: string, groupId: string): Promise<GroupMember[]>;
  /** Groups within a space that a member belongs to. */
  listGroupsForMember(
    spaceId: string,
    memberId: string,
  ): Promise<GroupMembership[]>;

  /** Create an inert service account plus its bound users-only admin group. */
  createServiceAccount(
    spaceId: string,
    name: string,
    opts?: {
      adminMembers?: { memberId: string; admin?: boolean }[];
      id?: string;
      adminGroupId?: string;
    },
  ): Promise<ServiceAccount>;
  getServiceAccount(id: string): Promise<ServiceAccount | null>;
  listServiceAccounts(spaceId: string): Promise<ServiceAccount[]>;
  renameServiceAccount(id: string, name: string): Promise<boolean>;
  deleteServiceAccount(id: string): Promise<boolean>;
  serviceAccountForAdminGroup(groupId: string): Promise<string | null>;
  /** Direct bound-admin-group membership; space-admin override is checked separately. */
  isServiceAccountAdmin(
    serviceAccountId: string,
    userId: string,
  ): Promise<boolean>;

  grantTreeAccess(
    spaceId: string,
    principalId: string,
    treePath: string,
    access: AccessLevel,
  ): Promise<void>;
  removeTreeAccessGrant(
    spaceId: string,
    principalId: string,
    treePath: string,
  ): Promise<boolean>;
  /**
   * The raw grant rows in a space, optionally for a single principal and/or
   * restricted to a subtree (`under`: grants at-or-below this path). Distinct
   * from buildTreeAccess, which resolves a member's *effective* access set.
   */
  listTreeAccessGrants(
    spaceId: string,
    principalId?: string,
    under?: string,
  ): Promise<TreeGrant[]>;

  /** Resolve a member's effective grants in a space (for the space functions). */
  buildTreeAccess(memberId: string, spaceId: string): Promise<TreeAccess>;

  /** Mint an api key for a member; returns the one-time plaintext secret. */
  createApiKey(
    memberId: string,
    name: string,
    opts?: { expiresAt?: Date },
  ): Promise<CreatedApiKey>;
  validateApiKey(
    lookupId: string,
    secret: string,
  ): Promise<ValidatedApiKey | null>;
  getApiKey(id: string): Promise<ApiKeyInfo | null>;
  listApiKeys(memberId: string): Promise<ApiKeyInfo[]>;
  /** Hard-delete a key (revoke ≡ delete; there is no soft-revoke state). */
  deleteApiKey(id: string): Promise<boolean>;

  /**
   * Issue an invitation to a space and mint its magic-link token (returned once,
   * stored only as a hash). `email` set → an email-constrained invite (re-inviting
   * the same email upserts the pending row); `email` null → an open shareable link.
   * `groupIds` are the groups the redeemer is added to on join — the union of
   * their grants is the joiner's access; `expiresAt` / `maxUses` bound an open link.
   */
  createSpaceInvitation(
    spaceId: string,
    email: string | null,
    opts: {
      admin: boolean;
      groupIds: string[];
      invitedBy: string;
      expiresAt?: Date | null;
      maxUses?: number | null;
    },
  ): Promise<CreatedInvitation>;
  /** Active invitations for a space (email-constrained + open links). */
  listSpaceInvitations(spaceId: string): Promise<SpaceInvitation[]>;
  /** Revoke a pending invitation by email. Returns true if one was removed. */
  revokeSpaceInvitation(spaceId: string, email: string): Promise<boolean>;
  /**
   * Revoke any invitation by id (an open link or an email invite). Returns true
   * if an active row was revoked.
   */
  revokeInvitationById(spaceId: string, invitationId: string): Promise<boolean>;
  /**
   * Redeem a magic-link token: join the space (owner@home) and the invite's
   * group. An
   * email-constrained token requires the caller's email to match (single-use); an
   * open link is multi-use (bounded by expiry / max-uses). Returns the joined
   * space, or null on any failure (bad/expired/revoked token, email mismatch,
   * exhausted).
   */
  redeemInvitation(
    token: string,
    userId: string,
    userEmail: string | null,
  ): Promise<RedeemedInvitation | null>;
  /**
   * Every pending invitation addressed to an email, across all spaces — the
   * invitee's view of what they can accept (case-insensitive match).
   */
  listInvitationsForEmail(email: string): Promise<PendingInvitationForEmail[]>;
  /**
   * Explicitly accept ONE pending invitation by id, gated on `email` (the
   * caller's verified email): join the space (owner@home + the invite's group)
   * and mark it accepted. Idempotent. Returns the joined space, or null
   * on mismatch / not-found / already-accepted. The user must already exist as a
   * core principal.
   */
  acceptSpaceInvitation(
    userId: string,
    email: string,
    invitationId: string,
  ): Promise<RedeemedInvitation | null>;
  /**
   * Decline (delete) ONE pending invitation by id, gated on `email`. Returns
   * true if a pending row was removed.
   */
  declineSpaceInvitation(email: string, invitationId: string): Promise<boolean>;

  /** Run operations atomically against the same transaction. */
  withTransaction<T>(fn: (db: CoreStore) => Promise<T>): Promise<T>;
}

function mapSpace(row: Record<string, unknown>): Space {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    language: row.language as string,
    createdAt: row.created_at as Date,
    updatedAt: (row.updated_at as Date | null) ?? null,
  };
}

function mapPrincipal(row: Record<string, unknown>): Principal {
  return {
    id: row.id as string,
    kind: row.kind as PrincipalKind,
    name: row.name as string,
    ownerId: (row.owner_id as string | null) ?? null,
    spaceId: (row.space_id as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: (row.updated_at as Date | null) ?? null,
  };
}

function mapSpacePrincipal(row: Record<string, unknown>): SpacePrincipal {
  return {
    id: row.id as string,
    kind: row.kind as PrincipalKind,
    name: row.name as string,
    ownerId: (row.owner_id as string | null) ?? null,
    admin: Boolean(row.admin),
    createdAt: row.created_at as Date,
    updatedAt: (row.updated_at as Date | null) ?? null,
  };
}

function mapGroup(row: Record<string, unknown>): Group {
  return {
    id: row.id as string,
    name: row.name as string,
    isSpaceAdmin: Boolean(row.is_space_admin),
    createdAt: row.created_at as Date,
    updatedAt: (row.updated_at as Date | null) ?? null,
  };
}

function mapServiceAccount(row: Record<string, unknown>): ServiceAccount {
  return {
    id: row.id as string,
    name: row.name as string,
    adminId: row.admin_id as string,
    spaceId: row.space_id as string,
    createdAt: row.created_at as Date,
    updatedAt: (row.updated_at as Date | null) ?? null,
  };
}

function mapApiKeyInfo(row: Record<string, unknown>): ApiKeyInfo {
  return {
    id: row.id as string,
    memberId: row.member_id as string,
    lookupId: row.lookup_id as string,
    name: row.name as string,
    createdAt: row.created_at as Date,
    expiresAt: (row.expires_at as Date | null) ?? null,
  };
}

export function coreStore(sql: Sql, schema: string = CORE_SCHEMA): CoreStore {
  const sch = sql(schema); // escaped schema identifier reused across queries

  const db: CoreStore = {
    async createSpace(slug, name, opts) {
      const [row] = await sql`
        select ${sch}.create_space(
          ${slug}, ${name}, ${opts?.language ?? null}, ${opts?.autoGrantHome ?? null}
        ) as id
      `;
      if (!row) throw new Error("create_space returned no row");
      return row.id as string;
    },

    async getSpace(slug) {
      const [row] = await sql`select * from ${sch}.get_space(${slug})`;
      return row ? mapSpace(row) : null;
    },

    async listSpaces() {
      const rows = await sql`select * from ${sch}.list_spaces()`;
      return rows.map(mapSpace);
    },

    async listSpacesForMember(memberId) {
      const rows = await sql`
        select * from ${sch}.list_spaces_for_member(${memberId})
      `;
      return rows.map(
        (r): MemberSpace => ({
          ...mapSpace(r),
          admin: Boolean(r.admin),
          autoGrantHome: Boolean(r.auto_grant_home),
          defaultGroup: r.default_group_id
            ? {
                id: r.default_group_id as string,
                name: r.default_group_name as string,
              }
            : null,
        }),
      );
    },

    async renameSpace(slug, name) {
      const [row] =
        await sql`select ${sch}.rename_space(${slug}, ${name}) as ok`;
      return Boolean(row?.ok);
    },

    async deleteSpace(slug) {
      const [row] = await sql`select ${sch}.delete_space(${slug}) as ok`;
      return Boolean(row?.ok);
    },

    async createUser(id, name) {
      const [row] = await sql`select ${sch}.create_user(${id}, ${name}) as id`;
      if (!row) throw new Error("create_user returned no row");
      return row.id as string;
    },

    async createAgent(ownerId, name, id) {
      const [row] = await sql`
        select ${sch}.create_agent(${ownerId}, ${name}, ${id ?? null}) as id
      `;
      if (!row) throw new Error("create_agent returned no row");
      return row.id as string;
    },

    async createGroup(spaceId, name, isSpaceAdmin = false, id) {
      const [row] = await sql`
        select ${sch}.create_group(
          ${spaceId}, ${name}, ${isSpaceAdmin}, ${id ?? null}
        ) as id
      `;
      if (!row) throw new Error("create_group returned no row");
      return row.id as string;
    },

    async provisionDefaultGroup(spaceId, name, grantDefaults) {
      const [row] = await sql`
        select ${sch}.provision_default_group(
          ${spaceId}, ${name ?? null}, ${grantDefaults ?? null}
        ) as id
      `;
      if (!row) throw new Error("provision_default_group returned no row");
      return row.id as string;
    },

    async getPrincipal(id) {
      const [row] = await sql`select * from ${sch}.get_principal(${id})`;
      return row ? mapPrincipal(row) : null;
    },

    async getUserByName(name) {
      const [row] = await sql`select * from ${sch}.get_user_by_name(${name})`;
      return row ? mapPrincipal(row) : null;
    },

    async renamePrincipal(id, name) {
      const [row] = await sql`
        select ${sch}.rename_principal(${id}, ${name}) as ok
      `;
      return Boolean(row?.ok);
    },

    async deletePrincipal(id) {
      const [row] = await sql`select ${sch}.delete_principal(${id}) as ok`;
      return Boolean(row?.ok);
    },

    async listSpacePrincipals(spaceId, kind) {
      const rows = await sql`
        select * from ${sch}.list_space_principals(${spaceId}, ${kind ?? null})
      `;
      return rows.map(mapSpacePrincipal);
    },

    async listSpaceGroups(spaceId) {
      const rows =
        await sql`select * from ${sch}.list_space_groups(${spaceId})`;
      return rows.map(mapGroup);
    },

    async setGroupIsSpaceAdmin(spaceId, groupId, isSpaceAdmin) {
      const [row] = await sql`
        select ${sch}.set_group_is_space_admin(
          ${spaceId}, ${groupId}, ${isSpaceAdmin}
        ) as updated
      `;
      return Boolean(row?.updated);
    },

    async listAgents(ownerId) {
      const rows = await sql`select * from ${sch}.list_agents(${ownerId})`;
      return rows.map(mapPrincipal);
    },

    async isSpaceAdmin(principalId, spaceId) {
      const [row] = await sql`
        select ${sch}.is_principal_space_admin(${principalId}, ${spaceId}) as ok
      `;
      return Boolean(row?.ok);
    },

    async isPrincipalInSpace(principalId, spaceId) {
      const [row] = await sql`
        select ${sch}.is_principal_in_space(${principalId}, ${spaceId}) as ok
      `;
      return Boolean(row?.ok);
    },

    async isGroupAdmin(memberId, groupId, spaceId) {
      const [row] = await sql`
        select ${sch}.is_group_admin(${memberId}, ${groupId}, ${spaceId}) as ok
      `;
      return Boolean(row?.ok);
    },

    async addPrincipalToSpace(spaceId, principalId, admin = false) {
      await sql`select ${sch}.add_principal_to_space(${spaceId}, ${principalId}, ${admin})`;
    },

    async removePrincipalFromSpace(spaceId, principalId) {
      const [row] = await sql`
        select ${sch}.remove_principal_from_space(${spaceId}, ${principalId}) as removed
      `;
      return Boolean(row?.removed);
    },

    async addGroupMember(spaceId, groupId, memberId, admin = false) {
      await sql`select ${sch}.add_group_member(${spaceId}, ${groupId}, ${memberId}, ${admin})`;
    },

    async removeGroupMember(spaceId, groupId, memberId) {
      const [row] = await sql`
        select ${sch}.remove_group_member(${spaceId}, ${groupId}, ${memberId}) as removed
      `;
      return Boolean(row?.removed);
    },

    async listGroupMembers(spaceId, groupId) {
      const rows = await sql`
        select * from ${sch}.list_group_members(${spaceId}, ${groupId})
      `;
      return rows.map(
        (r): GroupMember => ({
          memberId: r.member_id as string,
          kind: r.kind as PrincipalKind,
          name: r.name as string,
          admin: Boolean(r.admin),
          createdAt: r.created_at as Date,
        }),
      );
    },

    async listGroupsForMember(spaceId, memberId) {
      const rows = await sql`
        select * from ${sch}.list_groups_for_member(${spaceId}, ${memberId})
      `;
      return rows.map(
        (r): GroupMembership => ({
          groupId: r.group_id as string,
          name: r.name as string,
          admin: Boolean(r.admin),
          createdAt: r.created_at as Date,
        }),
      );
    },

    async createServiceAccount(spaceId, name, opts) {
      const adminMembers = opts?.adminMembers ?? [];
      const memberIds = adminMembers.map((m) => m.memberId);
      const groupAdminMemberIds = adminMembers
        .filter((m) => m.admin)
        .map((m) => m.memberId);
      const [created] = await sql`
        select * from ${sch}.create_service_account(
          ${spaceId}, ${name}, ${memberIds}::uuid[], ${groupAdminMemberIds}::uuid[],
          ${opts?.id ?? null}, ${opts?.adminGroupId ?? null}
        )
      `;
      if (!created) throw new Error("create_service_account returned no row");

      const account = await db.getServiceAccount(created.id as string);
      if (!account)
        throw new Error("created service account could not be loaded");
      return account;
    },

    async getServiceAccount(id) {
      const [row] = await sql`select * from ${sch}.get_service_account(${id})`;
      return row ? mapServiceAccount(row) : null;
    },

    async listServiceAccounts(spaceId) {
      const rows = await sql`
        select * from ${sch}.list_service_accounts(${spaceId})
      `;
      return rows.map(mapServiceAccount);
    },

    async renameServiceAccount(id, name) {
      if (!(await db.getServiceAccount(id))) return false;
      return db.renamePrincipal(id, name);
    },

    async deleteServiceAccount(id) {
      if (!(await db.getServiceAccount(id))) return false;
      return db.deletePrincipal(id);
    },

    async serviceAccountForAdminGroup(groupId) {
      const [row] = await sql`
        select ${sch}.service_account_for_admin_group(${groupId}) as id
      `;
      return (row?.id as string | null) ?? null;
    },

    async isServiceAccountAdmin(serviceAccountId, userId) {
      const [row] = await sql`
        select ${sch}.is_service_account_admin(${serviceAccountId}, ${userId}) as ok
      `;
      return Boolean(row?.ok);
    },

    async grantTreeAccess(spaceId, principalId, treePath, access) {
      await sql`
        select ${sch}.grant_tree_access(${spaceId}, ${principalId}, ${treePath}::ltree, ${access})
      `;
    },

    async removeTreeAccessGrant(spaceId, principalId, treePath) {
      const [row] = await sql`
        select ${sch}.remove_tree_access_grant(${spaceId}, ${principalId}, ${treePath}::ltree) as removed
      `;
      return Boolean(row?.removed);
    },

    async listTreeAccessGrants(spaceId, principalId, under) {
      const rows = await sql`
        select * from ${sch}.list_tree_access_grants(
          ${spaceId}, ${principalId ?? null}, ${under ?? null}::ltree
        )
      `;
      return rows.map(
        (r): TreeGrant => ({
          principalId: r.principal_id as string,
          treePath: r.tree_path as string,
          access: r.access as AccessLevel,
          createdAt: r.created_at as Date,
          updatedAt: (r.updated_at as Date | null) ?? null,
        }),
      );
    },

    async buildTreeAccess(memberId, spaceId) {
      const [row] = await sql`
        select ${sch}.build_tree_access(${memberId}, ${spaceId}) as ta
      `;
      return (row?.ta as TreeAccess) ?? [];
    },

    async createApiKey(memberId, name, opts) {
      const lookupId = generateLookupId();
      const secret = generateSecret();
      const secretHash = hashApiKeySecret(secret);
      const [row] = await sql`
        select ${sch}.create_api_key(
          ${memberId}, ${lookupId}, ${secretHash}, ${name}, ${opts?.expiresAt ?? null}
        ) as id
      `;
      if (!row) throw new Error("create_api_key returned no row");
      return { id: row.id as string, lookupId, secret };
    },

    async validateApiKey(lookupId, secret) {
      const secretHash = hashApiKeySecret(secret);
      const [row] = await sql`
        select member_id, api_key_id, owner_id
        from ${sch}.validate_api_key(${lookupId}, ${secretHash})
      `;
      if (!row) return null;
      return {
        memberId: row.member_id as string,
        apiKeyId: row.api_key_id as string,
        ownerId: (row.owner_id as string | null) ?? null,
      };
    },

    async getApiKey(id) {
      const [row] = await sql`select * from ${sch}.get_api_key(${id})`;
      return row ? mapApiKeyInfo(row) : null;
    },

    async listApiKeys(memberId) {
      const rows = await sql`select * from ${sch}.list_api_keys(${memberId})`;
      return rows.map(mapApiKeyInfo);
    },

    async deleteApiKey(id) {
      const [row] = await sql`select ${sch}.delete_api_key(${id}) as ok`;
      return Boolean(row?.ok);
    },

    async createSpaceInvitation(spaceId, email, opts) {
      const token = generateInviteToken();
      const [row] = await sql`
        select ${sch}.create_space_invitation(
          ${spaceId}, ${email}, ${opts.admin}, ${opts.groupIds}::uuid[],
          ${opts.invitedBy}, ${token},
          ${opts.expiresAt ?? null}, ${opts.maxUses ?? null}
        ) as id
      `;
      if (!row) throw new Error("create_space_invitation returned no row");
      return { id: row.id as string, token } satisfies CreatedInvitation;
    },

    async listSpaceInvitations(spaceId) {
      const rows = await sql`
        select * from ${sch}.list_space_invitations(${spaceId})
      `;
      return rows.map(
        (r): SpaceInvitation => ({
          id: r.id as string,
          email: (r.email as string | null) ?? null,
          kind: r.kind as "email" | "link",
          admin: Boolean(r.admin),
          groupIds: r.group_ids as string[],
          groupNames: (r.group_names as string[] | null) ?? [],
          invitedBy: (r.invited_by as string | null) ?? null,
          invitedByName: (r.invited_by_name as string | null) ?? null,
          expiresAt: (r.expires_at as Date | null) ?? null,
          maxUses: (r.max_uses as number | null) ?? null,
          uses: Number(r.uses ?? 0),
          valid: Boolean(r.valid),
          token: (r.token as string | null) ?? null,
          createdAt: r.created_at as Date,
        }),
      );
    },

    async revokeSpaceInvitation(spaceId, email) {
      const [row] = await sql`
        select ${sch}.revoke_space_invitation(${spaceId}, ${email}) as ok
      `;
      return Boolean(row?.ok);
    },

    async revokeInvitationById(spaceId, invitationId) {
      const [row] = await sql`
        select ${sch}.revoke_invitation_by_id(${spaceId}, ${invitationId}) as ok
      `;
      return Boolean(row?.ok);
    },

    async redeemInvitation(token, userId, userEmail) {
      if (!token) return null;
      const [row] = await sql`
        select * from ${sch}.redeem_invitation(${token}, ${userId}, ${userEmail})
      `;
      if (!row) return null;
      return {
        spaceId: row.space_id as string,
        slug: row.slug as string,
        name: row.name as string,
        admin: Boolean(row.admin),
        groupNames: (row.group_names as string[] | null) ?? [],
      } satisfies RedeemedInvitation;
    },

    async listInvitationsForEmail(email) {
      const rows = await sql`
        select * from ${sch}.list_pending_invitations_for_email(${email})
      `;
      return rows.map(
        (r): PendingInvitationForEmail => ({
          invitationId: r.invitation_id as string,
          spaceId: r.space_id as string,
          slug: r.slug as string,
          name: r.name as string,
          admin: Boolean(r.admin),
          groupNames: (r.group_names as string[] | null) ?? [],
          invitedByName: (r.invited_by_name as string | null) ?? null,
          createdAt: r.created_at as Date,
        }),
      );
    },

    async acceptSpaceInvitation(userId, email, invitationId) {
      const [row] = await sql`
        select * from ${sch}.accept_space_invitation(${userId}, ${email}, ${invitationId})
      `;
      if (!row) return null;
      return {
        spaceId: row.space_id as string,
        slug: row.slug as string,
        name: row.name as string,
        admin: Boolean(row.admin),
        groupNames: (row.group_names as string[] | null) ?? [],
      } satisfies RedeemedInvitation;
    },

    async declineSpaceInvitation(email, invitationId) {
      const [row] = await sql`
        select ${sch}.decline_space_invitation(${email}, ${invitationId}) as ok
      `;
      return Boolean(row?.ok);
    },

    async withTransaction<T>(fn: (db: CoreStore) => Promise<T>): Promise<T> {
      return sql.begin((tx) =>
        fn(coreStore(tx as unknown as Sql, schema)),
      ) as Promise<T>;
    },
  };

  return db;
}
