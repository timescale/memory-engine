/**
 * Prod → multiplayer ETL.
 *
 * One-time, in-place migration of the old org/engine/role + RLS model
 * (`accounts` + per-engine `me_<slug>`) to the new auth/core/space model
 * (`auth` + `core` + per-space `me_<slug>`), all in one database. See
 * PROD_MIGRATION_PLAN.md for the full mapping, decisions, and run procedure.
 *
 * Reuses the new code's own provisioning (`migrateAuth`/`migrateCore`/
 * `provisionSpace`) and `core` SQL functions (via `coreStore`) rather than
 * re-implementing schema/DDL — only the *reads* of the old schema and the
 * old→new transform live here.
 *
 * Phases:
 *   A  control plane  — `migrateControlPlane` — provision auth+core beside the
 *      live `accounts`, migrate identities/oauth/sessions. Safe while old serves.
 *   B  per engine     — `migrateEngine` — in one transaction: rename old
 *      `me_<slug>` aside, provision a fresh one, build the roster + grants,
 *      same-DB copy memories. Roll back on failure leaves the old schema intact.
 *   C  teardown       — `dropLegacy` / `dropAccounts` — explicit, operator-run
 *      AFTER cutover verification. Never called automatically.
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
  DEFAULT_SCHEMAS,
  legacySchema,
  type MigrationSchemas,
  spaceSchema,
} from "./schemas";

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
interface OldSession {
  identity_id: string;
  token_hash: Uint8Array;
  expires_at: Date;
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

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface EngineReport {
  slug: string;
  spaceId: string;
  name: string;
  members: number;
  groups: number;
  memories: number;
  warnings: string[];
}
export interface MigrationReport {
  identities: number;
  oauthAccounts: number;
  sessions: number;
  engines: EngineReport[];
  skippedEngines: { slug: string; reason: string }[];
  warnings: string[];
}

export interface MigrateOptions {
  /** Embedding dimension for the new space schemas (prod: 1536). */
  embeddingDimensions?: number;
  /** Copy live sessions so users stay logged in (default true). */
  migrateSessions?: boolean;
  /** Copy pending org invitations as per-space invitations (default true). */
  migrateInvitations?: boolean;
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
// Phase A — control plane (auth + core + identities)
// ---------------------------------------------------------------------------

export async function migrateControlPlane(
  sql: Sql,
  cfg: MigrationSchemas,
  opts: MigrateOptions,
): Promise<{
  identityIds: Set<string>;
  report: Pick<MigrationReport, "identities" | "oauthAccounts" | "sessions">;
}> {
  // Provision auth + core beside the (still live) `accounts` schema.
  await migrateAuth(sql, { schema: cfg.auth });
  await migrateCore(sql, { schema: cfg.core });

  const identities = await sql<OldIdentity[]>`
    select id, email::text as email, name, created_at from ${sql(cfg.accounts)}.identity
  `;
  const oauth = await sql<OldOAuth[]>`
    select identity_id, provider, provider_account_id, created_at
    from ${sql(cfg.accounts)}.oauth_account
  `;
  const sessions =
    opts.migrateSessions === false
      ? []
      : await sql<OldSession[]>`
          select identity_id, token_hash, expires_at, created_at
          from ${sql(cfg.accounts)}.session
          where expires_at > now()
        `;

  await sql.begin(async (tx) => {
    const core = coreStore(tx as unknown as Sql, cfg.core);

    for (const id of identities) {
      // Direct insert (not authStore.createUser) so the principal/auth user
      // keep the OLD identity.id — the auth.users.id == core.principal.id
      // invariant, with no remapping of session/account references.
      await tx`
        insert into ${tx(cfg.auth)}.users (id, name, email, email_verified, created_at)
        values (${id.id}, ${id.name}, ${id.email}, true, ${id.created_at})
      `;
      await core.createUser(id.id, id.email);
    }

    for (const a of oauth) {
      await tx`
        insert into ${tx(cfg.auth)}.accounts (user_id, provider_id, account_id, created_at)
        values (${a.identity_id}, ${a.provider}, ${a.provider_account_id}, ${a.created_at})
      `;
    }

    // Old and new both store token_hash = sha256(rawToken) as bytea and look up
    // by equality, so copying the hash verbatim keeps live sessions valid.
    for (const s of sessions) {
      await tx`
        insert into ${tx(cfg.auth)}.sessions (user_id, token_hash, expires_at, created_at)
        values (${s.identity_id}, ${s.token_hash}, ${s.expires_at}, ${s.created_at})
      `;
    }
  });

  return {
    identityIds: new Set(identities.map((i) => i.id)),
    report: {
      identities: identities.length,
      oauthAccounts: oauth.length,
      sessions: sessions.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase B — one engine → one space (rename-aside, roster, grants, memories)
// ---------------------------------------------------------------------------

export async function migrateEngine(
  sql: Sql,
  cfg: MigrationSchemas,
  engine: OldEngine,
  orgMembers: OldOrgMember[],
  invitations: OldInvitation[],
  identityIds: Set<string>,
  opts: MigrateOptions,
): Promise<EngineReport> {
  const slug = engine.slug;
  const newSchema = spaceSchema(cfg, slug); // me_<slug>, recreated fresh
  const legacy = legacySchema(cfg, slug); // legacy_<slug>, the renamed old schema
  const warnings: string[] = [];

  return (await sql.begin(async (tx) => {
    const core = coreStore(tx as unknown as Sql, cfg.core);

    // 1. Vacate the slug: rename the old engine schema aside.
    await tx`alter schema ${tx(newSchema)} rename to ${tx(legacy)}`;

    // 2. Create the space + a fresh me_<slug> data schema (same slug).
    const spaceId = await core.createSpace(slug, engine.name, engine.language);
    await provisionSpace(tx, {
      slug,
      schema: newSchema,
      embeddingDimensions: opts.embeddingDimensions ?? 1536,
      bm25TextConfig: engine.language,
    });

    // 3. Read old engine-internal access from the renamed-aside schema.
    const users = await tx<OldEngineUser[]>`
      select id, name, identity_id, can_login, superuser from ${tx(legacy)}."user"
    `;
    const owners = await tx<OldTreeOwner[]>`
      select tree_path::text as tree_path, user_id from ${tx(legacy)}.tree_owner
    `;
    const treeGrants = await tx<OldTreeGrant[]>`
      select tree_path::text as tree_path, user_id, actions, with_grant_option
      from ${tx(legacy)}.tree_grant
    `;
    const roleMemberships = await tx<OldRoleMembership[]>`
      select role_id, member_id, with_admin_option from ${tx(legacy)}.role_membership
    `;

    // 4. Map each old engine-`user` id to a new principal (a migrated identity)
    //    or a new group (an RBAC role: can_login = false).
    type Target = { kind: "principal" | "group"; id: string };
    const userMap = new Map<string, Target>();
    let groups = 0;
    for (const u of users) {
      if (!u.can_login) {
        const groupId = await core.createGroup(spaceId, u.name);
        userMap.set(u.id, { kind: "group", id: groupId });
        groups++;
      } else if (u.identity_id && identityIds.has(u.identity_id)) {
        userMap.set(u.id, { kind: "principal", id: u.identity_id });
      } else {
        warnings.push(
          `engine user ${u.id} (${u.name}) has no migrated identity (identity_id=${u.identity_id ?? "null"}); its grants are dropped`,
        );
      }
    }

    // 5. Accumulate tree-access grants, keeping the MAX level per (principal, path),
    //    so multiple sources never downgrade an earlier grant.
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

    // 6. Roster from org membership. add_principal_to_space grants owner@home;
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

    // 7. Engine superusers that somehow aren't org owner/admin → owner@root too.
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

    // 8. tree_owner → owner; tree_grant → mapped level.
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

    // 9. Apply the accumulated grants.
    for (const [principalId, paths] of grantAcc) {
      for (const [path, level] of paths) {
        await core.grantTreeAccess(spaceId, principalId, path, level);
      }
    }

    // 10. role_membership → group_member. New groups cannot nest (member must be
    //     u|a), so a role-in-role edge is dropped with a warning (see §4.4).
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

    // 11. Copy memories — same-DB insert…select, carrying embeddings (so the
    //     enqueue trigger only fires for rows that were never embedded).
    const [copied] = await tx<{ n: bigint }[]>`
      with ins as (
        insert into ${tx(newSchema)}.memory
          (id, meta, tree, temporal, content, embedding, embedding_version, created_at, updated_at)
        select id, meta, tree, temporal, content, embedding, embedding_version, created_at, updated_at
        from ${tx(legacy)}.memory
        returning 1
      )
      select count(*) as n from ins
    `;

    // 12. Optional: pending org invitations → per-space invitations (email-keyed).
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
      memories: Number(copied?.n ?? 0),
      warnings,
    };
  })) as EngineReport;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function migrateProdToMultiplayer(
  sql: Sql,
  cfg: MigrationSchemas = DEFAULT_SCHEMAS,
  opts: MigrateOptions = {},
): Promise<MigrationReport> {
  const { identityIds, report: a } = await migrateControlPlane(sql, cfg, opts);

  // Group org members + pending invitations by org for per-engine lookup.
  const engines = await sql<OldEngine[]>`
    select id, org_id, slug, name, language
    from ${sql(cfg.accounts)}.engine
    where status = 'active'
    order by created_at
  `;
  const orgMembers = await sql<OldOrgMember[]>`
    select org_id, identity_id, role from ${sql(cfg.accounts)}.org_member
  `;
  const invitations =
    opts.migrateInvitations === false
      ? []
      : await sql<OldInvitation[]>`
          select org_id, email::text as email, role, invited_by, expires_at
          from ${sql(cfg.accounts)}.invitation
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
  for (const engine of engines) {
    if (!(await schemaExists(sql, spaceSchema(cfg, engine.slug)))) {
      skipped.push({
        slug: engine.slug,
        reason: "data schema missing (orphaned engine row)",
      });
      continue;
    }
    engineReports.push(
      await migrateEngine(
        sql,
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

// ---------------------------------------------------------------------------
// Phase C — teardown (explicit, post-cutover; never auto-run)
// ---------------------------------------------------------------------------

/** Drop a single space's renamed-aside old schema. Call after verifying cutover. */
export async function dropLegacy(
  sql: Sql,
  cfg: MigrationSchemas,
  slug: string,
): Promise<void> {
  const legacy = legacySchema(cfg, slug);
  await sql`drop schema if exists ${sql(legacy)} cascade`;
}

/** Drop the old identity schema. Call after ALL engines are cut over + verified. */
export async function dropAccounts(
  sql: Sql,
  cfg: MigrationSchemas,
): Promise<void> {
  await sql`drop schema if exists ${sql(cfg.accounts)} cascade`;
}
