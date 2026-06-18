// In-place prod → multiplayer ETL, end-to-end against a real Postgres.
//
// Stands up the OLD schema (hand-mirrored server/v0.2.5 subset) + a seeded
// scenario in throwaway, prefixed schemas, runs the ETL in the same database
// (auth/core beside accounts; per engine rename-aside + provision + copy), then
// asserts the new-model rows. Defaults to the local me-postgres container; point
// TEST_DATABASE_URL elsewhere (see CLAUDE.md → Database integration tests).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { coreStore, type TreeAccess } from "@memory.build/engine/core";
import postgres, { type Sql } from "postgres";
import { type MigrationReport, migrateProdToMultiplayer } from "./migrate";
import {
  createOldAccountsSchema,
  type SeededScenario,
  seedScenario,
} from "./old-schema.fixture";
import {
  legacySchema,
  type MigrationSchemas,
  prefixed,
  spaceSchema,
} from "./schemas";

const EMB = 4; // small embedding dim keeps fixtures light
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

let sql: Sql;
let cfg: MigrationSchemas;
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
  sql = postgres(TEST_URL, { max: 4, onnotice: () => {} });
  cfg = prefixed(`mptest_${Math.random().toString(36).slice(2, 8)}_`);
  await createOldAccountsSchema(sql, cfg);
  scenario = await seedScenario(sql, cfg, EMB);
  report = await migrateProdToMultiplayer(sql, cfg, {
    embeddingDimensions: EMB,
  });
});

afterAll(async () => {
  if (sql) {
    for (const slug of [scenario?.personalSlug, scenario?.teamSlug]) {
      if (!slug) continue;
      await sql`drop schema if exists ${sql(spaceSchema(cfg, slug))} cascade`;
      await sql`drop schema if exists ${sql(legacySchema(cfg, slug))} cascade`;
    }
    for (const name of [cfg?.accounts, cfg?.auth, cfg?.core]) {
      if (name) await sql`drop schema if exists ${sql(name)} cascade`;
    }
    await sql.end();
  }
});

describe("control plane (Phase A)", () => {
  test("migrates every identity → auth.users + core.principal (kind u), same id", async () => {
    expect(report.identities).toBe(4);
    expect(await countRows(cfg.auth, "users")).toBe(4);
    const [p] = await sql.unsafe(
      `select count(*)::int as n from ${cfg.core}.principal where kind = 'u'`,
    );
    expect(Number(p?.n)).toBe(4);
    // the invariant: a user principal shares its auth.users id
    const [match] = await sql.unsafe(
      `select count(*)::int as n from ${cfg.auth}.users u
         join ${cfg.core}.principal pr on pr.id = u.id and pr.kind = 'u'`,
    );
    expect(Number(match?.n)).toBe(4);
  });

  test("migrates oauth accounts and preserves the user email handle", async () => {
    expect(report.oauthAccounts).toBe(4);
    expect(await countRows(cfg.auth, "accounts")).toBe(4);
    const [u] = await sql.unsafe(
      `select name from ${cfg.core}.principal where id = $1`,
      [scenario.i1],
    );
    expect(u?.name).toBe("owner1@example.com"); // principal name == email
  });

  test("migrates only the live session, hash copied verbatim", async () => {
    expect(report.sessions).toBe(1);
    expect(await countRows(cfg.auth, "sessions")).toBe(1);
    const [s] = await sql`
      select user_id, token_hash from ${sql(cfg.auth)}.sessions
      where token_hash = ${scenario.i1SessionHash}
    `;
    expect(s?.user_id).toBe(scenario.i1);
  });
});

describe("simple case — Personal org / single owner / default engine", () => {
  test("engine became a space with the SAME slug; owner is admin", async () => {
    const core = coreStore(sql, cfg.core);
    const space = await core.getSpace(scenario.personalSlug);
    expect(space).not.toBeNull();
    expect(
      await core.isSpaceAdmin(scenario.i1, spaceIdFor(scenario.personalSlug)),
    ).toBe(true);
  });

  test("owner (old superuser) gets owner@root and owner@home", async () => {
    const core = coreStore(sql, cfg.core);
    const ta = await core.buildTreeAccess(
      scenario.i1,
      spaceIdFor(scenario.personalSlug),
    );
    expect(hasAccess(ta, "", 3)).toBe(true); // owner@root
    expect(
      ta.some((g) => g.tree_path.startsWith("home") && g.access === 3),
    ).toBe(true);
  });

  test("memories copied verbatim with embeddings; only the null-embed row enqueues", async () => {
    const schema = spaceSchema(cfg, scenario.personalSlug);
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
    const core = coreStore(sql, cfg.core);
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
      `select tree_path::text as tree_path, access from ${cfg.core}.tree_access
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
    const core = coreStore(sql, cfg.core);
    const sid = spaceIdFor(scenario.teamSlug);
    const groups = await core.listSpaceGroups(sid);
    expect(groups.map((g) => g.name)).toContain("reviewers");
    const reviewers = groups.find((g) => g.name === "reviewers");
    if (!reviewers) throw new Error("reviewers group missing");
    const members = await core.listGroupMembers(sid, reviewers.id);
    expect(members.map((m) => m.name)).toContain("member@example.com");
    // group's grant: team.beta {create,update} → write(2)
    const [g] = await sql.unsafe(
      `select access from ${cfg.core}.tree_access
         where space_id = $1 and principal_id = $2 and tree_path = 'team.beta'`,
      [sid, reviewers.id],
    );
    expect(Number(g?.access)).toBe(2);
    // effective: the member reaches team.beta via the group
    const ta = await core.buildTreeAccess(scenario.i4, sid);
    expect(hasAccess(ta, "team.beta", 2)).toBe(true);
  });

  test("dangling-identity engine user is dropped with a warning", () => {
    expect(report.warnings.some((w) => /no migrated identity/.test(w))).toBe(
      true,
    );
  });

  test("pending org invitation became a per-space (email-keyed) invitation", async () => {
    const core = coreStore(sql, cfg.core);
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

  test("old data preserved under legacy_<slug> until teardown", async () => {
    // the rename-aside keeps the source intact for rollback
    expect(
      await countRows(legacySchema(cfg, scenario.teamSlug), "memory"),
    ).toBe(2);
  });
});
