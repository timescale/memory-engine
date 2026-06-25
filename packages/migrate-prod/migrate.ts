/**
 * Prod → multiplayer ETL.
 *
 * One-time migration of the old org/engine/role + RLS model to the new
 * auth/core/space model, across THREE databases (see PROD_MIGRATION_PLAN.md):
 *   - source `DB_ACCOUNTS` — identity (`accounts` schema)
 *   - source `DB_SHARD`    — memories (per-engine `me_<slug>` schemas)
 *   - target NEW database  — `auth` + `core` + per-space `me_<slug>`
 *
 * Reuses the new code's own provisioning (`migrateAuth`/`migrateCore`/
 * `provisionSpace`) and `core` SQL functions (via `coreStore`) — only the reads
 * of the old schema and the old→new transform live here.
 *
 * The sources are never modified, so rollback is just "point the app back at the
 * old databases" and there is no teardown SQL (decommission the old DBs out of
 * band). Because source and target are different databases, memories are copied
 * by **streaming** (a cursor over the shard in batches, one batched
 * `unnest(...::text[])` insert per batch into the target) — not `insert…select`.
 *
 * Phases:
 *   A  control plane  — `migrateControlPlane` — provision auth+core in the new DB,
 *      migrate identities + oauth from DB_ACCOUNTS. (Sessions can't migrate —
 *      better-auth stores raw session tokens; we only have old sha256 hashes.)
 *   B  per engine     — `migrateEngine` — one target transaction: create the
 *      space, provision its schema, build the roster + grants from DB_ACCOUNTS +
 *      DB_SHARD, stream-copy memories from DB_SHARD.
 */
import {
  migrateAuth,
  migrateCore,
  provisionSpace,
} from "@memory.build/database";
import {
  ACCESS,
  type AccessLevel,
  coreStore,
  ROOT_PATH,
} from "@memory.build/engine/core";
import type { Sql } from "postgres";
import { mapActionsToLevel, orgRoleIsAdmin } from "./mapping";
import {
  type MigrationConfig,
  sourceSpaceSchema,
  targetSpaceSchema,
} from "./schemas";

/** The three database connections the ETL spans. */
export interface Connections {
  /** DB_ACCOUNTS — read identities/orgs/engines/invitations. */
  accounts: Sql;
  /** DB_SHARD — read per-engine memories + access tables. */
  shard: Sql;
  /** The new database — all writes (auth/core/me_<slug>). */
  target: Sql;
}

/** Rows streamed from the shard are copied in batches of this size. */
const MEMORY_COPY_BATCH = 500;

// ---------------------------------------------------------------------------
// Old-schema row shapes (only the columns the ETL reads)
// ---------------------------------------------------------------------------

interface OldIdentity {
  id: string;
  email: string;
  name: string;
  created_at: Date;
}
interface OldOAuth {
  identity_id: string;
  provider: string;
  provider_account_id: string;
  created_at: Date;
}
interface OldEngine {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  language: string;
}
interface OldOrgMember {
  org_id: string;
  identity_id: string;
  role: string;
}
interface OldInvitation {
  org_id: string;
  email: string;
  role: string;
  invited_by: string;
  expires_at: Date;
}
interface OldEngineUser {
  id: string;
  name: string;
  identity_id: string | null;
  can_login: boolean;
  superuser: boolean;
}
interface OldTreeOwner {
  tree_path: string;
  user_id: string;
}
interface OldTreeGrant {
  tree_path: string;
  user_id: string;
  actions: string[];
  with_grant_option: boolean;
}
interface OldRoleMembership {
  role_id: string;
  member_id: string;
  with_admin_option: boolean;
}
/**
 * A memory row read entirely as text, so a single batched insert can re-cast
 * each column scalar-wise inside an `unnest(...::text[])`. Reading as text
 * sidesteps both the jsonb double-encoding footgun and postgres.js's lack of
 * native parsers for ltree/tstzrange/halfvec.
 */
interface OldMemoryRow {
  id: string;
  meta: string;
  tree: string;
  temporal: string | null;
  content: string;
  embedding: string | null;
  embedding_version: string;
  created_at: string;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface EngineReport {
  slug: string;
  spaceId: string;
  name: string;
  members: number;
  groups: number;
  /** Agents created from old service users (login users with no identity). */
  agents: number;
  memories: number;
  warnings: string[];
}
export interface MigrationReport {
  identities: number;
  oauthAccounts: number;
  engines: EngineReport[];
  skippedEngines: { slug: string; reason: string }[];
  warnings: string[];
}

export interface MigrateOptions {
  /** Embedding dimension for the new space schemas (prod: 1536). */
  embeddingDimensions?: number;
  /** Copy pending org invitations as per-space invitations (default true). */
  migrateInvitations?: boolean;
  /**
   * Restrict Phase B to these engine slugs (Phase A still migrates ALL
   * identities). For a rehearsal / smoke test — omit to migrate every active
   * engine.
   */
  engineSlugs?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function schemaExists(sql: Sql, name: string): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`
    select exists (select 1 from pg_namespace where nspname = ${name}) as present
  `;
  return Boolean(row?.present);
}

// ---------------------------------------------------------------------------
// Phase A — control plane (auth + core + identities), all in the target DB
// ---------------------------------------------------------------------------

export async function migrateControlPlane(
  conns: Connections,
  cfg: MigrationConfig,
): Promise<{
  identityIds: Set<string>;
  report: Pick<MigrationReport, "identities" | "oauthAccounts">;
}> {
  // Provision auth + core in the (empty) target database.
  await migrateAuth(conns.target, { schema: cfg.authSchema });
  await migrateCore(conns.target, { schema: cfg.coreSchema });

  const identities = await conns.accounts<OldIdentity[]>`
    select id, email::text as email, name, created_at
    from ${conns.accounts(cfg.accountsSchema)}.identity
  `;
  const oauth = await conns.accounts<OldOAuth[]>`
    select identity_id, provider, provider_account_id, created_at
    from ${conns.accounts(cfg.accountsSchema)}.oauth_account
  `;
  // Sessions are NOT migrated: better-auth's auth.sessions stores the *raw*
  // token (no `token_hash` column), and we only have old one-way sha256 hashes —
  // there's nothing to reconstruct. Everyone re-authenticates after cutover.

  await conns.target.begin(async (tx) => {
    const core = coreStore(tx as unknown as Sql, cfg.coreSchema);

    for (const id of identities) {
      // Direct insert (not authStore.createUser) so the principal/auth user
      // keep the OLD identity.id — the auth.users.id == core.principal.id
      // invariant, with no remapping of account references.
      await tx`
        insert into ${tx(cfg.authSchema)}.users (id, name, email, email_verified, created_at)
        values (${id.id}, ${id.name}, ${id.email}, true, ${id.created_at})
      `;
      await core.createUser(id.id, id.email);
    }

    for (const a of oauth) {
      await tx`
        insert into ${tx(cfg.authSchema)}.accounts (user_id, provider_id, account_id, created_at)
        values (${a.identity_id}, ${a.provider}, ${a.provider_account_id}, ${a.created_at})
      `;
    }
  });

  return {
    identityIds: new Set(identities.map((i) => i.id)),
    report: {
      identities: identities.length,
      oauthAccounts: oauth.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase B — one engine → one space (provision in target, copy from sources)
// ---------------------------------------------------------------------------

export async function migrateEngine(
  conns: Connections,
  cfg: MigrationConfig,
  engine: OldEngine,
  orgMembers: OldOrgMember[],
  invitations: OldInvitation[],
  identityIds: Set<string>,
  opts: MigrateOptions,
): Promise<EngineReport> {
  const slug = engine.slug;
  const sourceSchema = sourceSpaceSchema(cfg, slug); // me_<slug> in DB_SHARD
  const targetSchema = targetSpaceSchema(cfg, slug); // me_<slug> in the new DB
  const warnings: string[] = [];

  // Read the old engine-internal access from the shard (sources are read-only).
  const users = await conns.shard<OldEngineUser[]>`
    select id, name, identity_id, can_login, superuser from ${conns.shard(sourceSchema)}."user"
  `;
  const owners = await conns.shard<OldTreeOwner[]>`
    select tree_path::text as tree_path, user_id from ${conns.shard(sourceSchema)}.tree_owner
  `;
  const treeGrants = await conns.shard<OldTreeGrant[]>`
    select tree_path::text as tree_path, user_id, actions, with_grant_option
    from ${conns.shard(sourceSchema)}.tree_grant
  `;
  const roleMemberships = await conns.shard<OldRoleMembership[]>`
    select role_id, member_id, with_admin_option from ${conns.shard(sourceSchema)}.role_membership
  `;

  return (await conns.target.begin(async (tx) => {
    const core = coreStore(tx as unknown as Sql, cfg.coreSchema);

    // 1. Create the space + its fresh me_<slug> data schema (reuse the slug).
    const spaceId = await core.createSpace(slug, engine.name, engine.language);
    await provisionSpace(tx, {
      slug,
      schema: targetSchema,
      embeddingDimensions: opts.embeddingDimensions ?? 1536,
      bm25TextConfig: engine.language,
    });

    // The org owner (a migrated user) — owns agents minted from service users,
    // and its owner@root makes their clamped (agent_tree_access) grants effective.
    const ownerId =
      orgMembers.find(
        (m) => m.role === "owner" && identityIds.has(m.identity_id),
      )?.identity_id ??
      orgMembers.find((m) => identityIds.has(m.identity_id))?.identity_id;

    // 2. Map each old engine-`user` id to a new principal: a migrated identity,
    //    a group (an RBAC role, can_login=false), or — for a service user (a
    //    login user with no identity, i.e. an agent) — a NEW agent owned by the
    //    org owner.
    type Target = { kind: "principal" | "group"; id: string };
    const userMap = new Map<string, Target>();
    let groups = 0;
    let agents = 0;
    for (const u of users) {
      if (!u.can_login) {
        const groupId = await core.createGroup(spaceId, u.name);
        userMap.set(u.id, { kind: "group", id: groupId });
        groups++;
      } else if (u.identity_id && identityIds.has(u.identity_id)) {
        userMap.set(u.id, { kind: "principal", id: u.identity_id });
      } else if (u.identity_id === null) {
        // service user → an agent owned by the org owner, joined to the space
        // (owner@home.<owner>.<agent>); its grants flow through like any principal.
        if (!ownerId) {
          warnings.push(
            `service user ${u.id} (${u.name}): no migrated org owner to own it; grants dropped`,
          );
          continue;
        }
        const agentId = await core.createAgent(ownerId, u.name);
        await core.addPrincipalToSpace(spaceId, agentId); // agent: admin forced false
        userMap.set(u.id, { kind: "principal", id: agentId });
        agents++;
      } else {
        // can_login with an identity_id that wasn't migrated (dangling).
        warnings.push(
          `engine user ${u.id} (${u.name}) references a non-migrated identity ${u.identity_id}; its grants are dropped`,
        );
      }
    }

    // 3. Accumulate tree-access grants, keeping the MAX level per (principal, path).
    const grantAcc = new Map<string, Map<string, AccessLevel>>();
    const addGrant = (
      principalId: string,
      path: string,
      level: AccessLevel,
    ) => {
      let m = grantAcc.get(principalId);
      if (!m) {
        m = new Map();
        grantAcc.set(principalId, m);
      }
      const cur = m.get(path);
      if (cur === undefined || level > cur) m.set(path, level);
    };

    // 4. Roster from org membership. add_principal_to_space grants owner@home;
    //    org owner/admin (old engine superusers) also get owner@root.
    let members = 0;
    let adminCount = 0;
    for (const m of orgMembers) {
      if (!identityIds.has(m.identity_id)) {
        warnings.push(`org member ${m.identity_id} not migrated; skipped`);
        continue;
      }
      const admin = orgRoleIsAdmin(m.role);
      await core.addPrincipalToSpace(spaceId, m.identity_id, admin);
      members++;
      if (admin) {
        adminCount++;
        addGrant(m.identity_id, ROOT_PATH, ACCESS.owner); // owner@root
      }
    }
    if (adminCount === 0) {
      // enforce_last_admin would reject the commit; surface the data anomaly.
      throw new Error(
        `engine ${slug} (org ${engine.org_id}) has no admin-eligible member (no migrated org owner/admin); cannot satisfy enforce_last_admin`,
      );
    }

    // 5. Engine superusers that somehow aren't org owner/admin → owner@root too.
    for (const u of users) {
      if (
        u.can_login &&
        u.superuser &&
        u.identity_id &&
        identityIds.has(u.identity_id)
      ) {
        addGrant(u.identity_id, ROOT_PATH, ACCESS.owner);
      }
    }

    // 6. tree_owner → owner; tree_grant → mapped level.
    for (const o of owners) {
      const t = userMap.get(o.user_id);
      if (t) addGrant(t.id, o.tree_path, ACCESS.owner);
    }
    for (const g of treeGrants) {
      const t = userMap.get(g.user_id);
      if (t)
        addGrant(
          t.id,
          g.tree_path,
          mapActionsToLevel(g.actions, g.with_grant_option),
        );
    }

    // 7. Apply the accumulated grants.
    for (const [principalId, paths] of grantAcc) {
      for (const [path, level] of paths) {
        await core.grantTreeAccess(spaceId, principalId, path, level);
      }
    }

    // 8. role_membership → group_member. New groups cannot nest (member must be
    //    u|a), so a role-in-role edge is dropped with a warning (see §4.4).
    for (const rm of roleMemberships) {
      const group = userMap.get(rm.role_id);
      const member = userMap.get(rm.member_id);
      if (!group || group.kind !== "group") {
        warnings.push(
          `role_membership role ${rm.role_id} did not map to a group; edge dropped`,
        );
        continue;
      }
      if (!member) {
        warnings.push(
          `role_membership member ${rm.member_id} did not map; edge dropped`,
        );
        continue;
      }
      if (member.kind === "group") {
        warnings.push(
          `nested role membership (${rm.role_id} ⊃ ${rm.member_id}) unsupported by new groups; edge dropped — flatten manually`,
        );
        continue;
      }
      await core.addGroupMember(
        spaceId,
        group.id,
        member.id,
        rm.with_admin_option,
      );
    }

    // 9. Copy memories — cross-DB stream: a cursor over the shard (fetched in
    //    batches of MEMORY_COPY_BATCH), each batch inserted in ONE statement via
    //    unnest(...::text[]) with scalar casts in the projection. Every column is
    //    read as text so the casts re-apply cleanly (meta → jsonb without the
    //    text-param double-encoding footgun); `::halfvec` carries embeddings with
    //    null staying null, so the enqueue trigger only fires for never-embedded
    //    rows. The row-level trigger still fires once per inserted row.
    let memories = 0;
    for await (const rows of conns.shard<OldMemoryRow[]>`
      select id::text as id, meta::text as meta, tree::text as tree,
             temporal::text as temporal, content, embedding::text as embedding,
             embedding_version::text as embedding_version,
             created_at::text as created_at, updated_at::text as updated_at
      from ${conns.shard(sourceSchema)}.memory
    `.cursor(MEMORY_COPY_BATCH)) {
      if (rows.length === 0) continue;
      await tx.unsafe(
        // old memory.embedding_version → new memory.content_version (renamed on
        // main); the new `name` column stays null (old memories had no name).
        `insert into ${targetSchema}.memory
           (id, meta, tree, temporal, content, embedding, content_version, created_at, updated_at)
         select id::uuid, meta::jsonb, tree::ltree, temporal::tstzrange, content,
                embedding::halfvec, content_version::int, created_at::timestamptz, updated_at::timestamptz
         from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[])
              as t(id, meta, tree, temporal, content, embedding, content_version, created_at, updated_at)`,
        [
          rows.map((r) => r.id),
          rows.map((r) => r.meta),
          rows.map((r) => r.tree),
          rows.map((r) => r.temporal),
          rows.map((r) => r.content),
          rows.map((r) => r.embedding),
          rows.map((r) => r.embedding_version),
          rows.map((r) => r.created_at),
          rows.map((r) => r.updated_at),
        ],
      );
      memories += rows.length;
    }

    // 10. Optional: pending org invitations → per-space invitations (email-keyed).
    if (opts.migrateInvitations !== false) {
      for (const inv of invitations) {
        if (!identityIds.has(inv.invited_by)) {
          warnings.push(
            `invitation for ${inv.email} has unmigrated inviter; skipped`,
          );
          continue;
        }
        await core.createSpaceInvitation(spaceId, inv.email, {
          admin: orgRoleIsAdmin(inv.role),
          shareAccess: null,
          invitedBy: inv.invited_by,
        });
      }
    }

    return {
      slug,
      spaceId,
      name: engine.name,
      members,
      groups,
      agents,
      memories,
      warnings,
    };
  })) as EngineReport;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function migrateProdToMultiplayer(
  conns: Connections,
  cfg: MigrationConfig,
  opts: MigrateOptions = {},
): Promise<MigrationReport> {
  const { identityIds, report: a } = await migrateControlPlane(conns, cfg);

  const allEngines = await conns.accounts<OldEngine[]>`
    select id, org_id, slug, name, language
    from ${conns.accounts(cfg.accountsSchema)}.engine
    where status = 'active'
    order by created_at
  `;
  // Optional engine allow-list (e.g. for a rehearsal / smoke test).
  const engines = opts.engineSlugs
    ? allEngines.filter((e) => opts.engineSlugs?.includes(e.slug))
    : allEngines;
  const orgMembers = await conns.accounts<OldOrgMember[]>`
    select org_id, identity_id, role from ${conns.accounts(cfg.accountsSchema)}.org_member
  `;
  const invitations =
    opts.migrateInvitations === false
      ? []
      : await conns.accounts<OldInvitation[]>`
          select org_id, email::text as email, role, invited_by, expires_at
          from ${conns.accounts(cfg.accountsSchema)}.invitation
          where accepted_at is null and expires_at > now()
        `;

  const membersByOrg = new Map<string, OldOrgMember[]>();
  for (const m of orgMembers) {
    const list = membersByOrg.get(m.org_id) ?? [];
    list.push(m);
    membersByOrg.set(m.org_id, list);
  }
  const invitesByOrg = new Map<string, OldInvitation[]>();
  for (const inv of invitations) {
    const list = invitesByOrg.get(inv.org_id) ?? [];
    list.push(inv);
    invitesByOrg.set(inv.org_id, list);
  }

  const engineReports: EngineReport[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  // Flag any requested slug that isn't an active engine.
  if (opts.engineSlugs) {
    const active = new Set(allEngines.map((e) => e.slug));
    for (const slug of opts.engineSlugs) {
      if (!active.has(slug))
        skipped.push({ slug, reason: "not an active engine" });
    }
  }
  for (const engine of engines) {
    if (
      !(await schemaExists(conns.shard, sourceSpaceSchema(cfg, engine.slug)))
    ) {
      skipped.push({
        slug: engine.slug,
        reason: "shard schema missing (orphaned engine row)",
      });
      continue;
    }
    engineReports.push(
      await migrateEngine(
        conns,
        cfg,
        engine,
        membersByOrg.get(engine.org_id) ?? [],
        invitesByOrg.get(engine.org_id) ?? [],
        identityIds,
        opts,
      ),
    );
  }

  return {
    ...a,
    engines: engineReports,
    skippedEngines: skipped,
    warnings: engineReports.flatMap((e) =>
      e.warnings.map((w) => `[${e.slug}] ${w}`),
    ),
  };
}
