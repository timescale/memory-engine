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

export interface Space {
  id: string;
  slug: string;
  name: string;
  language: string;
  createdAt: Date;
  updatedAt: Date | null;
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
}
