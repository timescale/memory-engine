/**
 * Test fixture: a hand-mirrored subset of the OLD (server/v0.2.5) schema, plus a
 * seed covering the simple and complex migration cases.
 *
 * Only the tables/columns the ETL reads are reproduced — no RLS, roles, indexes,
 * or functions (the ETL reads tables as owner). This is a frozen snapshot of the
 * prod-era DDL; PROD_MIGRATION_PLAN.md §9 reconciles it against the live schema.
 * Hand-mirrored from /tmp/me-prod-v025 (`packages/accounts` + `packages/engine`).
 */
import type { Sql } from "postgres";
import { type MigrationSchemas, spaceSchema } from "./schemas";

/** Create the old `accounts` schema + the tables the ETL reads. */
export async function createOldAccountsSchema(
  sql: Sql,
  cfg: MigrationSchemas,
): Promise<void> {
  await sql`create extension if not exists citext`;
  const s = sql(cfg.accounts);
  await sql`create schema ${s}`;
  await sql`
    create table ${s}.identity
    ( id          uuid primary key default uuidv7()
    , email       citext not null unique
    , name        text not null
    , created_at  timestamptz not null default now()
    , updated_at  timestamptz
    )`;
  await sql`
    create table ${s}.oauth_account
    ( id                   uuid primary key default uuidv7()
    , identity_id          uuid not null
    , provider             text not null check (provider in ('google','github'))
    , provider_account_id  text not null
    , created_at           timestamptz not null default now()
    , unique (provider, provider_account_id)
    )`;
  await sql`
    create table ${s}.session
    ( id          uuid primary key default uuidv7()
    , identity_id uuid not null
    , expires_at  timestamptz not null
    , created_at  timestamptz not null default now()
    , token_hash  bytea not null unique
    )`;
  await sql`
    create table ${s}.org
    ( id          uuid primary key default uuidv7()
    , slug        text not null unique check (slug ~ '^[a-z0-9]{12}$')
    , name        text not null
    , created_at  timestamptz not null default now()
    )`;
  await sql`
    create table ${s}.org_member
    ( org_id      uuid not null
    , identity_id uuid not null
    , role        text not null check (role in ('owner','admin','member'))
    , created_at  timestamptz not null default now()
    , primary key (org_id, identity_id)
    )`;
  // shard_id (FK → shard) omitted: the ETL never reads it.
  await sql`
    create table ${s}.engine
    ( id          uuid primary key default uuidv7()
    , org_id      uuid not null
    , slug        text not null unique check (slug ~ '^[a-z0-9]{12}$')
    , name        text not null
    , status      text not null default 'active' check (status in ('active','suspended','deleted'))
    , language    text not null default 'english' check (language ~ '^[a-z_]+$')
    , created_at  timestamptz not null default now()
    , unique (org_id, name)
    )`;
  await sql`
    create table ${s}.invitation
    ( id          uuid primary key default uuidv7()
    , org_id      uuid not null
    , email       citext not null
    , role        text not null check (role in ('owner','admin','member'))
    , invited_by  uuid not null
    , expires_at  timestamptz not null
    , accepted_at timestamptz
    , created_at  timestamptz not null default now()
    , token_hash  bytea
    , unique (org_id, email)
    )`;
}

/** Create an old per-engine data schema `me_<slug>` (no RLS/indexes/functions). */
export async function createOldEngineSchema(
  sql: Sql,
  cfg: MigrationSchemas,
  slug: string,
  embeddingDim: number,
): Promise<void> {
  await sql`create extension if not exists ltree`;
  await sql`create extension if not exists vector`;
  const s = sql(spaceSchema(cfg, slug));
  await sql`create schema ${s}`;
  await sql.unsafe(`
    create table ${spaceSchema(cfg, slug)}.memory
    ( id                   uuid primary key default uuidv7()
    , meta                 jsonb not null default '{}'
    , tree                 ltree not null default ''
    , temporal             tstzrange
    , content              text not null
    , embedding            halfvec(${embeddingDim})
    , embedding_version    int not null default 1
    , embedding_attempts   int not null default 0
    , embedding_last_error text
    , created_at           timestamptz not null default now()
    , created_by           uuid
    , updated_at           timestamptz
    )`);
  await sql`
    create table ${s}."user"
    ( id          uuid primary key default uuidv7()
    , name        citext not null unique
    , identity_id uuid
    , can_login   boolean not null default true
    , superuser   boolean not null default false
    , createrole  boolean not null default false
    , created_at  timestamptz not null default now()
    , updated_at  timestamptz
    )`;
  await sql`
    create table ${s}.tree_owner
    ( tree_path   ltree primary key
    , user_id     uuid not null
    , created_by  uuid
    , created_at  timestamptz not null default now()
    )`;
  await sql`
    create table ${s}.tree_grant
    ( id                 uuid primary key default uuidv7()
    , user_id            uuid not null
    , tree_path          ltree not null
    , actions            text[] not null check (actions <@ '{read,create,update,delete}')
    , granted_by         uuid
    , with_grant_option  boolean not null default false
    , created_at         timestamptz not null default now()
    , unique (user_id, tree_path)
    )`;
  await sql`
    create table ${s}.role_membership
    ( role_id            uuid not null
    , member_id          uuid not null
    , with_admin_option  boolean not null default false
    , created_at         timestamptz not null default now()
    , primary key (role_id, member_id)
    )`;
}

// ---------------------------------------------------------------------------
// Seed: the simple + complex scenarios (see PROD_MIGRATION_PLAN.md §8)
// ---------------------------------------------------------------------------

export interface SeededScenario {
  /** identity ids */
  i1: string; // Personal-org owner (simple case)
  i2: string; // team-org owner
  i3: string; // team-org admin
  i4: string; // team-org plain member
  /** slugs */
  personalSlug: string;
  teamSlug: string;
  deletedSlug: string; // engine.status='deleted' → skipped
  orphanActiveSlug: string; // active engine, NO data schema → skipped
  /** the raw session token whose hash was seeded for i1 */
  i1SessionToken: string;
  i1SessionHash: Uint8Array;
  /** a pending-invite email in the team org */
  inviteEmail: string;
  /** ltree paths used for memory/grants */
  paths: { root: string; alpha: string; docs: string; teamBeta: string };
}

const PERSONAL_SLUG = "personaleng1";
const TEAM_SLUG = "teamengine02";
const DELETED_SLUG = "deleteng0003";
const ORPHAN_SLUG = "orphaneng004";

function vec(dim: number): string {
  return `[${Array.from({ length: dim }, (_, i) => (i + 1) / 10).join(",")}]`;
}

async function insertId(
  sql: Sql,
  schema: string,
  table: string,
  cols: Record<string, string | number | boolean | null>,
): Promise<string> {
  const keys = Object.keys(cols);
  const vals = keys.map((k) => cols[k] ?? null);
  const [row] = await sql.unsafe(
    `insert into ${schema}.${table} (${keys.join(",")}) values (${keys
      .map((_, i) => `$${i + 1}`)
      .join(",")}) returning id`,
    vals,
  );
  return row?.id as string;
}

/** Seed both scenarios; returns the ids/paths the assertions reference. */
export async function seedScenario(
  sql: Sql,
  cfg: MigrationSchemas,
  embeddingDim: number,
): Promise<SeededScenario> {
  const acc = cfg.accounts;
  const paths = {
    root: "",
    alpha: "projects.alpha",
    docs: "docs",
    teamBeta: "team.beta",
  };

  // --- Identities ---
  const i1 = await insertId(sql, acc, "identity", {
    email: "owner1@example.com",
    name: "Owner One",
  });
  const i2 = await insertId(sql, acc, "identity", {
    email: "teamowner@example.com",
    name: "Team Owner",
  });
  const i3 = await insertId(sql, acc, "identity", {
    email: "teamadmin@example.com",
    name: "Team Admin",
  });
  const i4 = await insertId(sql, acc, "identity", {
    email: "member@example.com",
    name: "Plain Member",
  });

  for (const [id, provider] of [
    [i1, "github"],
    [i2, "google"],
    [i3, "github"],
    [i4, "github"],
  ] as const) {
    await sql`insert into ${sql(acc)}.oauth_account (identity_id, provider, provider_account_id)
              values (${id}, ${provider}, ${`acct-${id}`})`;
  }

  // A live session for i1, to assert session migration (hash copied verbatim).
  const i1SessionToken = "tok-owner1-abcdefghijklmnopqrstuvwxyz0123456789";
  const i1SessionHash = new Bun.CryptoHasher("sha256")
    .update(i1SessionToken)
    .digest();
  await sql`insert into ${sql(acc)}.session (identity_id, expires_at, token_hash)
            values (${i1}, now() + interval '30 days', ${i1SessionHash})`;
  // An expired session (should NOT migrate).
  await sql`insert into ${sql(acc)}.session (identity_id, expires_at, token_hash)
            values (${i1}, now() - interval '1 day', ${new Bun.CryptoHasher("sha256").update("expired").digest()})`;

  // --- Personal org (simple): i1 owner, one active engine "default" ---
  const personalOrg = await insertId(sql, acc, "org", {
    slug: PERSONAL_SLUG,
    name: "Personal",
  });
  await sql`insert into ${sql(acc)}.org_member (org_id, identity_id, role) values (${personalOrg}, ${i1}, 'owner')`;
  await sql`insert into ${sql(acc)}.engine (org_id, slug, name, language) values (${personalOrg}, ${PERSONAL_SLUG}, 'default', 'english')`;

  await createOldEngineSchema(sql, cfg, PERSONAL_SLUG, embeddingDim);
  const pe = spaceSchema(cfg, PERSONAL_SLUG);
  // i1 is the org owner → superuser engine user (no tree_owner row; superuser flag).
  const peU1 = await insertId(sql, pe, '"user"', {
    name: "owner1@example.com",
    identity_id: i1,
    can_login: true,
    superuser: true,
  });
  // Memories: one at root WITH embedding, one at a path WITH embedding, one WITHOUT (→ enqueue).
  await sql.unsafe(
    `insert into ${pe}.memory (content, tree, embedding, created_by) values
       ('root memo', '', '${vec(embeddingDim)}'::halfvec(${embeddingDim}), '${peU1}'),
       ('alpha memo', 'projects.alpha', '${vec(embeddingDim)}'::halfvec(${embeddingDim}), '${peU1}'),
       ('no-embed memo', 'projects.alpha', null, '${peU1}')`,
  );

  // --- Team org (complex): i2 owner, i3 admin, i4 member; RBAC role + grants ---
  const teamOrg = await insertId(sql, acc, "org", {
    slug: TEAM_SLUG,
    name: "Team",
  });
  await sql`insert into ${sql(acc)}.org_member (org_id, identity_id, role) values
              (${teamOrg}, ${i2}, 'owner'), (${teamOrg}, ${i3}, 'admin'), (${teamOrg}, ${i4}, 'member')`;
  await sql`insert into ${sql(acc)}.engine (org_id, slug, name, language) values (${teamOrg}, ${TEAM_SLUG}, 'team space', 'english')`;

  await createOldEngineSchema(sql, cfg, TEAM_SLUG, embeddingDim);
  const te = spaceSchema(cfg, TEAM_SLUG);
  const teU2 = await insertId(sql, te, '"user"', {
    name: "teamowner@example.com",
    identity_id: i2,
    can_login: true,
    superuser: true,
  });
  // i3 (team admin) also has a superuser engine user; its id isn't needed below.
  await insertId(sql, te, '"user"', {
    name: "teamadmin@example.com",
    identity_id: i3,
    can_login: true,
    superuser: true,
  });
  const teU4 = await insertId(sql, te, '"user"', {
    name: "member@example.com",
    identity_id: i4,
    can_login: true,
    superuser: false,
  });
  // An RBAC role (can_login=false) and a service/orphan user (dangling identity).
  const teRole = await insertId(sql, te, '"user"', {
    name: "reviewers",
    can_login: false,
    superuser: false,
  });
  await insertId(sql, te, '"user"', {
    name: "orphan-svc",
    identity_id: "00000000-0000-7000-8000-000000000000",
    can_login: true,
  });

  // i4 owns a subtree; has a read grant; the role has a write-ish grant; i4 is in the role.
  await sql`insert into ${sql(te)}.tree_owner (tree_path, user_id) values (${"team.alpha"}::ltree, ${teU4})`;
  await sql`insert into ${sql(te)}.tree_grant (user_id, tree_path, actions) values (${teU4}, ${"docs"}::ltree, ${sql.array(["read"])})`;
  await sql`insert into ${sql(te)}.tree_grant (user_id, tree_path, actions) values (${teRole}, ${"team.beta"}::ltree, ${sql.array(["create", "update"])})`;
  await sql`insert into ${sql(te)}.role_membership (role_id, member_id) values (${teRole}, ${teU4})`;

  await sql.unsafe(
    `insert into ${te}.memory (content, tree, embedding, created_by) values
       ('team root', '', '${vec(embeddingDim)}'::halfvec(${embeddingDim}), '${teU2}'),
       ('alpha doc', 'team.alpha', '${vec(embeddingDim)}'::halfvec(${embeddingDim}), '${teU4}')`,
  );

  // Pending invitation in the team org (i2 invites a new email).
  const inviteEmail = "invitee@example.com";
  await sql`insert into ${sql(acc)}.invitation (org_id, email, role, invited_by, expires_at, token_hash)
            values (${teamOrg}, ${inviteEmail}, 'member', ${i2}, now() + interval '7 days', ${new Bun.CryptoHasher("sha256").update("invtok").digest()})`;

  // --- Skipped engines ---
  // status='deleted' (filtered out by the ETL).
  const delOrg = await insertId(sql, acc, "org", {
    slug: DELETED_SLUG,
    name: "Deleted Org",
  });
  await sql`insert into ${sql(acc)}.org_member (org_id, identity_id, role) values (${delOrg}, ${i1}, 'owner')`;
  await sql`insert into ${sql(acc)}.engine (org_id, slug, name, status) values (${delOrg}, ${DELETED_SLUG}, 'gone', 'deleted')`;
  // active engine row but NO data schema (orphan → skipped with a reason).
  await sql`insert into ${sql(acc)}.engine (org_id, slug, name) values (${personalOrg}, ${ORPHAN_SLUG}, 'orphan')`;

  return {
    i1,
    i2,
    i3,
    i4,
    personalSlug: PERSONAL_SLUG,
    teamSlug: TEAM_SLUG,
    deletedSlug: DELETED_SLUG,
    orphanActiveSlug: ORPHAN_SLUG,
    i1SessionToken,
    i1SessionHash,
    inviteEmail,
    paths,
  };
}
