/**
 * Types for the core control-plane TS layer.
 *
 * This layer is intentionally thin: every method calls a core SQL function
 * (see packages/database/core/migrate/idempotent/*.sql) and never queries the
 * core tables directly.
 */

export type PrincipalKind = "u" | "g" | "a" | "s";

/** Access levels stored in core.tree_access: 1 = read, 2 = write, 3 = owner. */
export type AccessLevel = 1 | 2 | 3;

/** Named tree-access levels — use instead of the raw 1/2/3. */
export const ACCESS = {
  read: 1,
  write: 2,
  owner: 3,
} as const satisfies Record<string, AccessLevel>;

/**
 * The root tree path: the empty ltree (`''`), which is the ancestor of every
 * path — so a grant here covers the whole space. (ltree separates with `.`, not
 * `/`, and its root is the empty path; `/` is not an ltree concept and is
 * reserved for agent names like `user/agent`.)
 */
export const ROOT_PATH = "";

export interface Space {
  id: string;
  slug: string;
  name: string;
  language: string;
  createdAt: Date;
  updatedAt: Date | null;
}

/** A space a principal is a direct member of, with the principal's effective admin flag. */
export interface MemberSpace extends Space {
  admin: boolean;
  /** Whether joining users/agents automatically get owner@~ (custom spaces set false). */
  autoGrantHome: boolean;
  /** The space's default/invite group (is_default_group), or null if it has none. */
  defaultGroup: { id: string; name: string } | null;
}

export interface Principal {
  id: string;
  kind: PrincipalKind;
  name: string;
  ownerId: string | null;
  spaceId: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}

/**
 * The effective access set for a member in a space, as produced by
 * core.build_tree_access and consumed verbatim by the space data-plane
 * functions (search_memory, get_memory, …). Kept in the on-the-wire snake_case
 * shape because it is passed straight through to those functions as jsonb.
 */
export type TreeAccess = { tree_path: string; access: number }[];

export interface CreatedApiKey {
  /** The api_key row id. */
  id: string;
  /** The lookup id (goes in the key string, used for the indexed lookup). */
  lookupId: string;
  /** The plaintext secret — returned once; only its sha256 hash is stored. */
  secret: string;
}

export interface ValidatedApiKey {
  /** The principal (user, agent, or service account) the key belongs to. */
  memberId: string;
  /** The api_key row id. */
  apiKeyId: string;
  /** The member's owner — non-null when the key-holder is an agent, null for a user. */
  ownerId: string | null;
  /**
   * The member's kind — always one of u|a|s in practice (groups hold no key).
   * Returned alongside the key so the auth middleware need not re-fetch the
   * principal just to learn the kind.
   */
  kind: PrincipalKind;
  /**
   * The member's principal name (the user's email for a user PAT, else the
   * agent/service-account handle). Saves the middleware a second lookup.
   */
  name: string;
}

/**
 * A principal on a space's roster — i.e. with a direct principal_space row.
 * Users, agents, groups (a group is rostered into its space on creation), and
 * service accounts. This is about the principal's own roster entry, not
 * membership conferral: a member who is only in a group (no principal_space row
 * of their own) is still not a space member. `admin` is the effective
 * space-admin status.
 */
export interface SpacePrincipal {
  id: string;
  kind: PrincipalKind;
  name: string;
  ownerId: string | null;
  admin: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}

/** A direct-member user who is an effective space admin. */
export interface EffectiveSpaceAdmin {
  id: string;
  name: string;
}

/** A group (kind 'g') belonging to a space. */
export interface Group {
  id: string;
  name: string;
  /**
   * Admin group: its own principal_space.admin (authority flows to members).
   * Distinct from a group member's own admin flag (GroupMember.admin).
   */
  isSpaceAdmin: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}

/** A member (user / agent / service account) of a group, with the group admin flag. */
export interface GroupMember {
  memberId: string;
  kind: PrincipalKind;
  name: string;
  admin: boolean;
  createdAt: Date;
}

/** A group a member belongs to, with the group admin flag. */
export interface GroupMembership {
  groupId: string;
  name: string;
  admin: boolean;
  createdAt: Date;
}

/** A space-scoped service account and its bound admin group. */
export interface ServiceAccount {
  id: string;
  name: string;
  adminId: string;
  spaceId: string;
  createdAt: Date;
  updatedAt: Date | null;
}

/** A tree-access grant row. */
export interface TreeGrant {
  principalId: string;
  treePath: string;
  access: AccessLevel;
  createdAt: Date;
  updatedAt: Date | null;
}

/** Api key metadata (never includes the secret). */
export interface ApiKeyInfo {
  id: string;
  memberId: string;
  lookupId: string;
  name: string;
  createdAt: Date;
  expiresAt: Date | null;
  /** UTC date string (YYYY-MM-DD) of the last successful api-key auth. */
  lastUsedOn: string | null;
}

/**
 * A pending invitation to a space, keyed by invitee email (so an invite can be
 * issued before the user registers). Redeemed by explicit acceptance against the
 * verified email; see CoreStore.acceptSpaceInvitation.
 */
export interface SpaceInvitation {
  id: string;
  /** Invitee email — null for an open shareable link (addressed to no one). */
  email: string | null;
  /** "email" = email-constrained (single-use); "link" = open shareable link. */
  kind: "email" | "link";
  /** Make the user a space admin on redemption. */
  admin: boolean;
  /** The groups the redeemer is added to on join (their grants are the access). */
  groupIds: string[];
  /** Display names of those groups ("team" by default); excludes any since deleted. */
  groupNames: string[];
  /** The principal who issued the invite (null if it has since been deleted). */
  invitedBy: string | null;
  /** Display name of the inviter (a user's name is their email), if resolvable. */
  invitedByName: string | null;
  /** When the (open-link) invite expires; null = never. */
  expiresAt: Date | null;
  /** Max redemptions for an open link; null = unlimited. */
  maxUses: number | null;
  /** How many times it has been redeemed so far. */
  uses: number;
  /** Whether it can still be redeemed (not expired / exhausted / revoked). */
  valid: boolean;
  /** The raw magic-link token (so an admin can re-copy the URL); null on legacy rows. */
  token: string | null;
  createdAt: Date;
}

/** A freshly-created invitation: its id and the one-time magic-link token. */
export interface CreatedInvitation {
  id: string;
  /** The full `inv.<lookupId>.<secret>` token — shown once, then only hashed. */
  token: string;
}

/**
 * A pending invitation addressed to an email, across all spaces — the invitee's
 * view of what they can accept. See CoreStore.listInvitationsForEmail.
 */
export interface PendingInvitationForEmail {
  invitationId: string;
  spaceId: string;
  slug: string;
  name: string;
  admin: boolean;
  /** The groups the invite joins the redeemer to ("team" by default). */
  groupNames: string[];
  invitedByName: string | null;
  createdAt: Date;
}

/** A space joined by accepting an invitation. */
export interface RedeemedInvitation {
  spaceId: string;
  slug: string;
  name: string;
  admin: boolean;
  /** The groups the redeemer was added to ("team" by default). */
  groupNames: string[];
}
