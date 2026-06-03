import { CORE_SCHEMA } from "@memory.build/database";
import type { Sql } from "postgres";
import { generateLookupId, generateSecret, hashApiKeySecret } from "./api-key";
import type {
  AccessLevel,
  CreatedApiKey,
  Principal,
  PrincipalKind,
  Space,
  TreeAccess,
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
  createSpace(slug: string, name: string, language?: string): Promise<string>;
  getSpace(slug: string): Promise<Space | null>;

  createUser(id: string, name: string): Promise<string>;
  createAgent(ownerId: string, name: string, id?: string): Promise<string>;
  createGroup(spaceId: string, name: string, id?: string): Promise<string>;
  getPrincipal(id: string): Promise<Principal | null>;

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

export function coreStore(sql: Sql, schema: string = CORE_SCHEMA): CoreStore {
  const sch = sql(schema); // escaped schema identifier reused across queries

  const db: CoreStore = {
    async createSpace(slug, name, language) {
      const [row] = await sql`
        select ${sch}.create_space(${slug}, ${name}, ${language ?? null}) as id
      `;
      if (!row) throw new Error("create_space returned no row");
      return row.id as string;
    },

    async getSpace(slug) {
      const [row] = await sql`select * from ${sch}.get_space(${slug})`;
      return row ? mapSpace(row) : null;
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

    async createGroup(spaceId, name, id) {
      const [row] = await sql`
        select ${sch}.create_group(${spaceId}, ${name}, ${id ?? null}) as id
      `;
      if (!row) throw new Error("create_group returned no row");
      return row.id as string;
    },

    async getPrincipal(id) {
      const [row] = await sql`select * from ${sch}.get_principal(${id})`;
      return row ? mapPrincipal(row) : null;
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
        select member_id, api_key_id
        from ${sch}.validate_api_key(${lookupId}, ${secretHash})
      `;
      if (!row) return null;
      return {
        memberId: row.member_id as string,
        apiKeyId: row.api_key_id as string,
      };
    },

    async withTransaction<T>(fn: (db: CoreStore) => Promise<T>): Promise<T> {
      return sql.begin((tx) =>
        fn(coreStore(tx as unknown as Sql, schema)),
      ) as Promise<T>;
    },
  };

  return db;
}
