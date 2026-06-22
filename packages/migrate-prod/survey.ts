#!/usr/bin/env bun
/**
 * §9 verification survey — READ-ONLY against the live source databases.
 *
 *   DB_ACCOUNTS=… DB_SHARD=… bun packages/migrate-prod/survey.ts
 *   (Bun auto-loads .env.local, where DB_ACCOUNTS / DB_SHARD live.)
 *
 * Confirms the live DDL matches what the ETL expects (server/v0.2.5) and surveys
 * the data shape so we know how much of the complex mapping prod actually
 * exercises (multi-member orgs, RBAC roles, non-trivial grants, orphans). Prints
 * aggregates only — no emails / content / secrets. Every statement is a SELECT;
 * each session is pinned read-only with a short statement timeout.
 */
import postgres, { type Sql } from "postgres";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} (expected in .env.local).`);
    process.exit(1);
  }
  return v;
}

function connect(url: string): Sql {
  return postgres(url, {
    max: 2,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
    // belt-and-suspenders: the session refuses writes even if a query slipped.
    connection: {
      default_transaction_read_only: true,
      statement_timeout: 30_000,
    },
  });
}

/** A stable physical-cluster fingerprint, to tell same-DB from same-named-DB. */
async function serverIdentity(sql: Sql): Promise<string> {
  const [db] = await sql<{ db: string }[]>`select current_database() as db`;
  try {
    const [r] = await sql<{ sid: string }[]>`
      select system_identifier::text as sid from pg_control_system()
    `;
    return `${db?.db}@cluster:${r?.sid}`;
  } catch {
    const [r] = await sql<{ addr: string | null; port: number | null }[]>`
      select host(inet_server_addr()) as addr, inet_server_port() as port
    `;
    return `${db?.db}@${r?.addr ?? "?"}:${r?.port ?? "?"}`;
  }
}

/** Columns the ETL reads, per table — the actionable DDL-drift check. */
const ACCOUNTS_COLUMNS: Record<string, string[]> = {
  identity: ["id", "email", "name", "created_at"],
  oauth_account: [
    "identity_id",
    "provider",
    "provider_account_id",
    "created_at",
  ],
  session: ["identity_id", "token_hash", "expires_at", "created_at"],
  org: ["id", "slug", "name"],
  org_member: ["org_id", "identity_id", "role"],
  engine: ["id", "org_id", "slug", "name", "language", "status", "created_at"],
  invitation: [
    "org_id",
    "email",
    "role",
    "invited_by",
    "expires_at",
    "accepted_at",
  ],
};
const SHARD_COLUMNS: Record<string, string[]> = {
  memory: [
    "id",
    "meta",
    "tree",
    "temporal",
    "content",
    "embedding",
    "embedding_version",
    "created_at",
    "updated_at",
  ],
  user: ["id", "name", "identity_id", "can_login", "superuser"],
  tree_owner: ["tree_path", "user_id"],
  tree_grant: ["tree_path", "user_id", "actions", "with_grant_option"],
  role_membership: ["role_id", "member_id", "with_admin_option"],
};

async function missingColumns(
  sql: Sql,
  schema: string,
  expected: Record<string, string[]>,
): Promise<string[]> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = ${schema}
  `;
  const have = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = have.get(r.table_name) ?? new Set<string>();
    set.add(r.column_name);
    have.set(r.table_name, set);
  }
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(expected)) {
    const set = have.get(table);
    if (!set) {
      missing.push(`${schema}.${table} (table absent)`);
      continue;
    }
    for (const c of cols)
      if (!set.has(c)) missing.push(`${schema}.${table}.${c}`);
  }
  return missing;
}

function h(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function surveyAccounts(sql: Sql): Promise<{
  identityIds: Set<string>;
  engineSlugs: string[];
}> {
  h("DB_ACCOUNTS · DDL drift (columns the ETL reads)");
  const missing = await missingColumns(sql, "accounts", ACCOUNTS_COLUMNS);
  console.log(
    missing.length
      ? `⚠️ MISSING: ${missing.join(", ")}`
      : "✓ all expected columns present",
  );

  h("DB_ACCOUNTS · counts");
  const [c] = await sql`
    select
      (select count(*) from accounts.identity)                              as identities,
      (select count(*) from accounts.oauth_account)                         as oauth_accounts,
      (select count(*) from accounts.session)                               as sessions_total,
      (select count(*) from accounts.session where expires_at > now())      as sessions_live,
      (select count(*) from accounts.org)                                   as orgs,
      (select count(*) from accounts.org_member)                            as org_members,
      (select count(*) from accounts.engine)                                as engines,
      (select count(*) from accounts.engine where status = 'active')        as engines_active,
      (select count(*) from accounts.invitation where accepted_at is null and expires_at > now()) as pending_invites
  `;
  console.table([c]);

  h("DB_ACCOUNTS · engine.status / org_member.role / language");
  console.table(
    await sql`select status, count(*) from accounts.engine group by status order by status`,
  );
  console.table(
    await sql`select role, count(*) from accounts.org_member group by role order by role`,
  );
  console.table(
    await sql`select language, count(*) from accounts.engine group by language order by language`,
  );

  h("DB_ACCOUNTS · org size distribution (members per org)");
  console.table(
    await sql`
    select members, count(*) as orgs from (
      select org_id, count(*) as members from accounts.org_member group by org_id
    ) t group by members order by members
  `,
  );

  h("DB_ACCOUNTS · engines per org distribution");
  console.table(
    await sql`
    select engines, count(*) as orgs from (
      select org_id, count(*) as engines from accounts.engine group by org_id
    ) t group by engines order by engines
  `,
  );

  h("DB_ACCOUNTS · anomaly: orgs with no owner");
  const noOwner = await sql`
    select o.id, o.slug from accounts.org o
    where not exists (
      select 1 from accounts.org_member m where m.org_id = o.id and m.role = 'owner'
    )
  `;
  console.log(
    noOwner.length
      ? `⚠️ ${noOwner.length} org(s) with no owner: ${noOwner.map((r) => r.slug).join(", ")}`
      : "✓ every org has an owner",
  );

  const ids = await sql<{ id: string }[]>`select id from accounts.identity`;
  const engines = await sql<
    { slug: string; status: string }[]
  >`select slug, status from accounts.engine`;
  return {
    identityIds: new Set(ids.map((r) => r.id)),
    engineSlugs: engines
      .filter((e) => e.status === "active")
      .map((e) => e.slug),
  };
}

async function surveyShard(
  sql: Sql,
  accountsIdentityIds: Set<string>,
  activeEngineSlugs: string[],
): Promise<void> {
  h("DB_SHARD · me_<slug> schemas");
  const schemas = (
    await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname ~ '^me_[a-z0-9]{12}$' order by nspname
    `
  ).map((r) => r.nspname);
  console.log(`found ${schemas.length} engine schema(s)`);
  if (schemas.length === 0) return;

  // DDL drift on a sample schema.
  const sample = schemas[0] as string;
  h(`DB_SHARD · DDL drift (sample ${sample})`);
  const missing = await missingColumns(sql, sample, SHARD_COLUMNS);
  console.log(
    missing.length
      ? `⚠️ MISSING: ${missing.join(", ")}`
      : "✓ all expected columns present",
  );

  // Per-schema stats in one UNION ALL round trip.
  const statsSql = schemas
    .map(
      (s) => `select '${s}' as schema,
        (select count(*) from "${s}".memory) as memories,
        (select count(*) from "${s}".memory where embedding is null) as null_embeddings,
        (select count(*) from "${s}"."user" where can_login = false) as rbac_roles,
        (select count(*) from "${s}"."user" where identity_id is null and can_login) as service_users,
        (select count(*) from "${s}".role_membership) as role_edges,
        (select count(*) from "${s}".tree_owner where tree_path <> '') as nonroot_owners,
        (select count(*) from "${s}".tree_grant) as grants,
        (select count(*) from "${s}".tree_grant
           where with_grant_option
              or not (actions @> '{read,create,update,delete}')) as nontrivial_grants`,
    )
    .join("\nunion all\n");
  const stats = await sql.unsafe(statsSql);
  console.table(stats);

  h("DB_SHARD · totals across all engine schemas");
  const sum = (k: string) => stats.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  console.table([
    {
      memories: sum("memories"),
      null_embeddings: sum("null_embeddings"),
      rbac_roles: sum("rbac_roles"),
      service_users: sum("service_users"),
      role_edges: sum("role_edges"),
      nonroot_owners: sum("nonroot_owners"),
      grants: sum("grants"),
      nontrivial_grants: sum("nontrivial_grants"),
    },
  ]);

  // Detail for the few engines that exercise roles / grants / service users —
  // each grant/owner labelled by what kind of user holds it (identity vs RBAC
  // role vs service user with no identity → the cases the ETL must handle).
  const interesting = stats
    .filter(
      (r) =>
        Number(r.grants) > 0 ||
        Number(r.rbac_roles) > 0 ||
        Number(r.service_users) > 0,
    )
    .map((r) => r.schema as string);
  for (const s of interesting) {
    h(`DB_SHARD · detail · ${s}`);
    console.log("tree_grant (per holder):");
    console.table(
      await sql.unsafe(`
        select g.tree_path::text as tree_path, g.actions, g.with_grant_option,
               case when not u.can_login then 'rbac_role'
                    when u.identity_id is null then 'service_user'
                    else 'identity' end as holder,
               u.superuser
        from "${s}".tree_grant g join "${s}"."user" u on u.id = g.user_id
        order by holder`),
    );
    console.log("tree_owner (per holder):");
    console.table(
      await sql.unsafe(`
        select o.tree_path::text as tree_path,
               case when not u.can_login then 'rbac_role'
                    when u.identity_id is null then 'service_user'
                    else 'identity' end as holder
        from "${s}".tree_owner o join "${s}"."user" u on u.id = o.user_id`),
    );
    const roleEdges = await sql.unsafe(
      `select count(*)::int as n from "${s}".role_membership`,
    );
    console.log(`role_membership edges: ${roleEdges[0]?.n ?? 0}`);
  }

  // Cross-DB orphans.
  h("CROSS-DB · orphans");
  const schemaSet = new Set(schemas.map((s) => s.slice(3))); // strip "me_"
  const enginesNoSchema = activeEngineSlugs.filter(
    (slug) => !schemaSet.has(slug),
  );
  const schemasNoEngine = [...schemaSet].filter(
    (slug) => !activeEngineSlugs.includes(slug),
  );
  console.log(
    `active engines with NO shard schema: ${enginesNoSchema.length}${enginesNoSchema.length ? ` → ${enginesNoSchema.join(", ")}` : ""}`,
  );
  console.log(
    `shard schemas with NO active engine row: ${schemasNoEngine.length}${schemasNoEngine.length ? ` → ${schemasNoEngine.join(", ")}` : ""}`,
  );

  // Engine users whose identity_id doesn't resolve in DB_ACCOUNTS.
  const userIdsSql = schemas
    .map(
      (s) =>
        `select distinct identity_id from "${s}"."user" where identity_id is not null`,
    )
    .join("\nunion\n");
  const shardIdentityIds = (
    await sql.unsafe<{ identity_id: string }[]>(userIdsSql)
  ).map((r) => r.identity_id);
  const dangling = shardIdentityIds.filter(
    (id) => !accountsIdentityIds.has(id),
  );
  console.log(
    `engine users with dangling identity_id (absent from accounts.identity): ${dangling.length}${dangling.length ? ` → ${dangling.join(", ")}` : ""}`,
  );
}

async function main(): Promise<void> {
  const accounts = connect(requireEnv("DB_ACCOUNTS"));
  const shard = connect(requireEnv("DB_SHARD"));
  try {
    const [aId, sId] = await Promise.all([
      serverIdentity(accounts),
      serverIdentity(shard),
    ]);
    console.log(`DB_ACCOUNTS → ${aId}\nDB_SHARD    → ${sId}`);
    console.log(
      aId === sId
        ? "⚠️ SAME physical database — the two URLs point at one cluster+db (cross-DB copy still works, but in-place is an option)."
        : "✓ distinct physical databases — the cross-DB (streaming) ETL is required.",
    );
    const { identityIds, engineSlugs } = await surveyAccounts(accounts);
    await surveyShard(shard, identityIds, engineSlugs);
    console.log("\n✓ survey complete (read-only).");
  } finally {
    await Promise.all([accounts.end(), shard.end()]);
  }
}

await main();
