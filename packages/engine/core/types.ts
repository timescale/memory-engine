/**
 * Types for the core control-plane TS layer.
 *
 * This layer is intentionally thin: every method calls a core SQL function
 * (see packages/database/core/migrate/idempotent/*.sql) and never queries the
 * core tables directly.
 */

export type PrincipalKind = "u" | "g" | "a";

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
  /** The principal (user or agent) the key belongs to. */
  memberId: string;
  /** The api_key row id. */
  apiKeyId: string;
  /** The member's owner — non-null when the key-holder is an agent, null for a user. */
  ownerId: string | null;
}

/**
 * A principal that is a member of a space — i.e. has a direct principal_space
 * row (group membership alone does not make you a space member). `admin` is the
 * effective space-admin status (a direct admin row OR a direct member who
 * belongs to an admin group, never an agent).
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

/** A group (kind 'g') belonging to a space. */
export interface Group {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date | null;
}

/** A member (user / agent) of a group, with the group admin flag. */
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
}

/**
 * A pending invitation to a space, keyed by invitee email (so an invite can be
 * issued before the user registers). Redeemed at login against the verified
 * email; see CoreStore.redeemSpaceInvitations.
 */
export interface SpaceInvitation {
  id: string;
  email: string;
  /** Make the user a space admin on redemption. */
  admin: boolean;
  /** Access granted at the shared root on redemption; null = no share grant. */
  shareAccess: AccessLevel | null;
  /** The principal who issued the invite (null if it has since been deleted). */
  invitedBy: string | null;
  /** Display name of the inviter (a user's name is their email), if resolvable. */
  invitedByName: string | null;
  createdAt: Date;
}

/** A space joined by redeeming an invitation. */
export interface RedeemedInvitation {
  spaceId: string;
  slug: string;
  name: string;
  admin: boolean;
  shareAccess: AccessLevel | null;
}
