// Prod → multiplayer ETL, end-to-end against a real Postgres.
//
// In prod the ETL spans three databases (DB_ACCOUNTS, DB_SHARD, new target).
// The test stands in ONE physical database for all three connections — the
// source per-engine schemas carry a distinct `shard_me_` prefix so they don't
// collide with the target `me_` schemas (see schemas.ts `prefixed`). It seeds the
// OLD schema (hand-mirrored server/v0.2.5 subset) + a scenario, runs the ETL, and
// asserts the new-model rows. Defaults to the local me-postgres container; point
// TEST_DATABASE_URL elsewhere (see CLAUDE.md → Database integration tests).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { coreStore, type TreeAccess } from "@memory.build/engine/core";
import postgres, { type Sql } from "postgres";
import {
  type Connections,
  type MigrationReport,
  migrateProdToMultiplayer,
} from "./migrate";
import {
  createOldAccountsSchema,
  type SeededScenario,
  seedScenario,
} from "./old-schema.fixture";
import {
  type MigrationConfig,
  prefixed,
  sourceSpaceSchema,
  targetSpaceSchema,
} from "./schemas";

const EMB = 4; // small embedding dim keeps fixtures light
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

let sql: Sql;
let conns: Connections;
let cfg: MigrationConfig;
let scenario: SeededScenario;
let report: MigrationReport;

function spaceIdFor(slug: string): string {
  const e = report.engines.find((r) => r.slug === slug);
  if (!e) throw new Error(`no engine report for ${slug}`);
  return e.spaceId;
}

/** Effective access at a path (>= level), as resolved by build_tree_access. */
function hasAccess(ta: TreeAccess, path: string, atLeast: number): boolean {
  return ta.some((g) => g.tree_path === path && g.access >= atLeast);
}

async function countRows(schema: string, table: string): Promise<number> {
  const [row] = await sql.unsafe(
    `select count(*)::int as n from ${schema}.${table}`,
  );
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  // One physical client stands in for all three connections; the source vs
  // target schema prefixes keep them from colliding.
  sql = postgres(TEST_URL, { max: 6, onnotice: () => {} });
  conns = { accounts: sql, shard: sql, target: sql };
  cfg = prefixed(`mptest_${Math.random().toString(36).slice(2, 8)}_`);
  await createOldAccountsSchema(sql, cfg);
  scenario = await seedScenario(sql, cfg, EMB);
  report = await migrateProdToMultiplayer(conns, cfg, {
    embeddingDimensions: EMB,
  });
});

afterAll(async () => {
  if (sql) {
    for (const slug of [scenario?.personalSlug, scenario?.teamSlug]) {
      if (!slug) continue;
      await sql`drop schema if exists ${sql(sourceSpaceSchema(cfg, slug))} cascade`;
      await sql`drop schema if exists ${sql(targetSpaceSchema(cfg, slug))} cascade`;
    }
    for (const name of [
      cfg?.accountsSchema,
      cfg?.authSchema,
      cfg?.coreSchema,
    ]) {
      if (name) await sql`drop schema if exists ${sql(name)} cascade`;
    }
    await sql.end();
  }
});

describe("control plane (Phase A)", () => {
  test("migrates every identity → auth.users + core.principal (kind u), same id", async () => {
    expect(report.identities).toBe(4);
    expect(await countRows(cfg.authSchema, "users")).toBe(4);
    const [p] = await sql.unsafe(
      `select count(*)::int as n from ${cfg.coreSchema}.principal where kind = 'u'`,
    );
    expect(Number(p?.n)).toBe(4);
    // the invariant: a user principal shares its auth.users id
    const [match] = await sql.unsafe(
      `select count(*)::int as n from ${cfg.authSchema}.users u
         join ${cfg.coreSchema}.principal pr on pr.id = u.id and pr.kind = 'u'`,
    );
    expect(Number(match?.n)).toBe(4);
  });

  test("migrates oauth accounts and preserves the user email handle", async () => {
    expect(report.oauthAccounts).toBe(4);
    expect(await countRows(cfg.authSchema, "accounts")).toBe(4);
    const [u] = await sql.unsafe(
      `select name from ${cfg.coreSchema}.principal where id = $1`,
      [scenario.i1],
    );
    expect(u?.name).toBe("owner1@example.com"); // principal name == email
  });

  test("migrates only the live session, hash copied verbatim", async () => {
    expect(report.sessions).toBe(1);
    expect(await countRows(cfg.authSchema, "sessions")).toBe(1);
    const [s] = await sql`
      select user_id, token_hash from ${sql(cfg.authSchema)}.sessions
      where token_hash = ${scenario.i1SessionHash}
    `;
    expect(s?.user_id).toBe(scenario.i1);
  });
});

describe("simple case — Personal org / single owner / default engine", () => {
  test("engine became a space with the SAME slug; owner is admin", async () => {
    const core = coreStore(sql, cfg.coreSchema);
    const space = await core.getSpace(scenario.personalSlug);
    expect(space).not.toBeNull();
    expect(
      await core.isSpaceAdmin(scenario.i1, spaceIdFor(scenario.personalSlug)),
    ).toBe(true);
  });

  test("owner (old superuser) gets owner@root and owner@home", async () => {
    const core = coreStore(sql, cfg.coreSchema);
    const ta = await core.buildTreeAccess(
      scenario.i1,
      spaceIdFor(scenario.personalSlug),
    );
    expect(hasAccess(ta, "", 3)).toBe(true); // owner@root
    expect(
      ta.some((g) => g.tree_path.startsWith("home") && g.access === 3),
    ).toBe(true);
  });

  test("memories copied with embeddings; only the null-embed row enqueues", async () => {
    const schema = targetSpaceSchema(cfg, scenario.personalSlug);
    expect(await countRows(schema, "memory")).toBe(3);
    expect(await countRows(schema, "embedding_queue")).toBe(1);
    // tree paths preserved, including root ''
    const rows = await sql.unsafe(
      `select tree::text as tree from ${schema}.memory order by tree`,
    );
    expect(rows.map((r) => r.tree as string).sort()).toEqual([
      "",
      "projects.alpha",
      "projects.alpha",
    ]);
  });
});

describe("complex case — multi-member org, RBAC role, explicit grants", () => {
  test("org owner/admin → space admins with owner@root; plain member is neither", async () => {
    const core = coreStore(sql, cfg.coreSchema);
    const sid = spaceIdFor(scenario.teamSlug);
    expect(await core.isSpaceAdmin(scenario.i2, sid)).toBe(true);
    expect(await core.isSpaceAdmin(scenario.i3, sid)).toBe(true);
    expect(await core.isSpaceAdmin(scenario.i4, sid)).toBe(false);
    expect(hasAccess(await core.buildTreeAccess(scenario.i2, sid), "", 3)).toBe(
      true,
    );
    expect(hasAccess(await core.buildTreeAccess(scenario.i4, sid), "", 3)).toBe(
      false,
    );
  });

  test("member keeps tree_owner→owner and tree_grant(read)→read, plus owner@home", async () => {
    const sid = spaceIdFor(scenario.teamSlug);
    const grants = await sql.unsafe(
      `select tree_path::text as tree_path, access from ${cfg.coreSchema}.tree_access
         where space_id = $1 and principal_id = $2 order by tree_path`,
      [sid, scenario.i4],
    );
    const got = grants.map((g) => `${g.tree_path}=${g.access}`);
    expect(got).toContain("team.alpha=3"); // tree_owner → owner
    expect(got).toContain("docs=1"); // tree_grant {read} → read
    expect(got.some((g) => g.startsWith("home"))).toBe(true); // owner@home
    expect(grants.some((g) => g.tree_path === "")).toBe(false); // no owner@root
  });

  test("RBAC role → group; member is in it; group's write grant resolves for the member", async () => {
    const core = coreStore(sql, cfg.coreSchema);
    const sid = spaceIdFor(scenario.teamSlug);
    const groups = await core.listSpaceGroups(sid);
    expect(groups.map((g) => g.name)).toContain("reviewers");
    const reviewers = groups.find((g) => g.name === "reviewers");
    if (!reviewers) throw new Error("reviewers group missing");
    const members = await core.listGroupMembers(sid, reviewers.id);
    expect(members.map((m) => m.name)).toContain("member@example.com");
    // group's grant: team.beta {create,update} → write(2)
    const [g] = await sql.unsafe(
      `select access from ${cfg.coreSchema}.tree_access
         where space_id = $1 and principal_id = $2 and tree_path = 'team.beta'`,
      [sid, reviewers.id],
    );
    expect(Number(g?.access)).toBe(2);
    // effective: the member reaches team.beta via the group
    const ta = await core.buildTreeAccess(scenario.i4, sid);
    expect(hasAccess(ta, "team.beta", 2)).toBe(true);
  });

  test("dangling-identity engine user is dropped with a warning", () => {
    expect(report.warnings.some((w) => /non-migrated identity/.test(w))).toBe(
      true,
    );
  });

  test("service user (no identity) → agent owned by the org owner, with its grant", async () => {
    const core = coreStore(sql, cfg.coreSchema);
    const sid = spaceIdFor(scenario.teamSlug);
    expect(
      report.engines.find((e) => e.slug === scenario.teamSlug)?.agents,
    ).toBe(1);
    // a kind='a' agent named "codex" owned by the team owner (i2)
    const [agent] = await sql.unsafe(
      `select id from ${cfg.coreSchema}.principal where kind = 'a' and owner_id = $1 and name = 'codex'`,
      [scenario.i2],
    );
    expect(agent?.id).toBeDefined();
    const agentId = agent?.id as string;
    // rostered in the space, and its old {read} grant on pb is preserved
    const [rostered] = await sql.unsafe(
      `select 1 as ok from ${cfg.coreSchema}.principal_space where space_id = $1 and principal_id = $2`,
      [sid, agentId],
    );
    expect(rostered?.ok).toBe(1);
    const [grant] = await sql.unsafe(
      `select access from ${cfg.coreSchema}.tree_access where space_id = $1 and principal_id = $2 and tree_path = 'pb'`,
      [sid, agentId],
    );
    expect(Number(grant?.access)).toBe(1);
    // effective (clamped under the owner's owner@root) — the agent reaches pb
    expect(hasAccess(await core.buildTreeAccess(agentId, sid), "pb", 1)).toBe(
      true,
    );
  });

  test("pending org invitation became a per-space (email-keyed) invitation", async () => {
    const core = coreStore(sql, cfg.coreSchema);
    const invites = await core.listSpaceInvitations(
      spaceIdFor(scenario.teamSlug),
    );
    const inv = invites.find((i) => i.email === scenario.inviteEmail);
    expect(inv).toBeDefined();
    expect(inv?.admin).toBe(false);
  });
});

describe("engine selection", () => {
  test("active engines migrate; deleted are ignored; active-without-schema is skipped", () => {
    expect(report.engines.map((e) => e.slug).sort()).toEqual(
      [scenario.personalSlug, scenario.teamSlug].sort(),
    );
    expect(report.skippedEngines.map((s) => s.slug)).toContain(
      scenario.orphanActiveSlug,
    );
    expect(report.engines.map((e) => e.slug)).not.toContain(
      scenario.deletedSlug,
    );
  });

  test("source databases left untouched (rollback = repoint at them)", async () => {
    // the ETL only reads the sources; the old shard schema still holds memories
    expect(
      await countRows(sourceSpaceSchema(cfg, scenario.teamSlug), "memory"),
    ).toBe(2);
  });
});
