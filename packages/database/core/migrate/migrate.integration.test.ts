// Integration tests for the `core` control-plane migrations (migrateCore).
//
// The core migrations are templated, so each test targets its own throwaway
// `core_test_<rand>` schema — never the real `core`. That makes these tests
// isolated and safe to run against any database (including a shared dev one).
// Read-only shape assertions share one canonical core provisioned in beforeAll;
// the few behavior tests provision their own. Tests run serially within the
// file; cross-suite parallelism comes from `bun run test:db` (separate
// processes for core and space).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql as SQL } from "postgres";
import { template } from "../../migrate/kit";
import { CORE_SCHEMA_VERSION } from "../version";
import backfill012 from "./incremental/012_default_groups.sql" with {
  type: "text",
};
import { migrateCore } from "./migrate";
import {
  appliedMigrations,
  connect,
  expectReject,
  extensionInstalled,
  getSchemaVersion,
  listFunctions,
  listTables,
  listTriggers,
  randomCoreSchema,
  schemaExists,
  TestCore,
  tableExists,
  withTestCore,
} from "./test-utils";

const EXPECTED_TABLES = [
  "api_key",
  "group_member",
  "migration",
  "principal",
  "principal_space",
  "space",
  "space_invitation",
  "space_invitation_redemption",
  "tree_access",
  "version",
];

const EXPECTED_MIGRATIONS = [
  "001_space",
  "002_principal",
  "003_principal_space",
  "004_group_member",
  "005_tree_access",
  "006_api_key",
  "007_space_invitation",
  "008_principal_name",
  "009_invitation_links",
  "010_roster_existing_groups",
  "011_group_member_space_fk",
  "012_default_groups",
  "013_invite_groups",
  "014_space_access_defaults",
  "015_service_accounts",
];

const EXPECTED_FUNCTIONS = [
  "_delete_service_account_admin_group",
  "_enforce_service_account_admin_group_not_space_admin",
  "_enforce_service_account_principal_invariants",
  "agent_tree_access",
  "create_service_account",
  "enforce_group_space_coherence",
  "enforce_invitation_groups_coherence",
  "get_service_account",
  "is_service_account_admin",
  "is_principal_in_space",
  "is_principal_space_admin",
  "list_service_accounts",
  "member_groups",
  "member_tree_access",
  "provision_default_group",
  "service_account_for_admin_group",
  "service_account_tree_access",
  "set_group_is_space_admin",
  "update_updated_at",
  "user_tree_access",
];

const REQUIRED_EXTENSIONS = ["citext", "ltree", "vector", "pg_textsearch"];

/** A valid space slug: 12 lowercase alphanumerics (see space.slug check). */
function randomSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let slug = "";
  for (const b of bytes) slug += alphabet[b % 36];
  return slug;
}

let sql: SQL;
// One migrated core shared by all read-only shape/function assertions.
let canonical: TestCore;

beforeAll(async () => {
  sql = connect(12);
  canonical = await TestCore.create(sql); // migrateCore installs extensions itself
});

afterAll(async () => {
  await canonical?.drop();
  await sql.end();
});

describe("provisioned core schema", () => {
  test("provisions into the requested (templated) schema", async () => {
    expect(canonical.schema).toMatch(/^core_test_/);
    expect(await schemaExists(sql, canonical.schema)).toBe(true);
  });

  test("creates infrastructure and domain tables", async () => {
    const tables = await listTables(sql, canonical.schema);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
  });

  test("records every incremental migration exactly once", async () => {
    expect(await appliedMigrations(sql, canonical.schema)).toEqual(
      EXPECTED_MIGRATIONS,
    );
  });

  test("stamps the schema version", async () => {
    expect(await getSchemaVersion(sql, canonical.schema)).toBe(
      CORE_SCHEMA_VERSION,
    );
  });

  test("installs all required extensions", async () => {
    for (const ext of REQUIRED_EXTENSIONS) {
      expect(await extensionInstalled(sql, ext)).toBe(true);
    }
  });

  test("creates the access-control functions in the schema", async () => {
    const functions = await listFunctions(sql, canonical.schema);
    for (const fn of EXPECTED_FUNCTIONS) {
      expect(functions).toContain(fn);
    }
  });

  test("installs updated_at triggers on mutable tables", async () => {
    for (const table of [
      "space",
      "principal",
      "principal_space",
      "group_member",
      "tree_access",
      "space_invitation",
    ]) {
      const triggers = await listTriggers(sql, canonical.schema, table);
      expect(triggers).toContain(`${table}_before_update_trg`);
    }
  });
});

describe("schema constraints enforce", () => {
  test("principal.kind is restricted to g/u/a/s", async () => {
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.principal (kind, name) values ('x', 'bad-kind')`,
      ),
    );
  });

  test("principal ids must be UUIDv7", async () => {
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.principal (id, kind, name)
         values ('00000000-0000-4000-8000-000000000000', 'u', 'v4-id')`,
      ),
    );
  });

  test("space.slug must be 12 lowercase alphanumerics", async () => {
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.space (slug, name) values ('BAD', 'x')`,
      ),
    );
  });

  test("user names are globally unique", async () => {
    const name = `smoke_unique_${crypto.randomUUID().slice(0, 8)}`;
    await sql.unsafe(
      `insert into ${canonical.schema}.principal (kind, name) values ('u', '${name}')`,
    );
    try {
      await expectReject(() =>
        sql.unsafe(
          `insert into ${canonical.schema}.principal (kind, name) values ('u', '${name}')`,
        ),
      );
    } finally {
      await sql.unsafe(
        `delete from ${canonical.schema}.principal where name = '${name}'`,
      );
    }
  });

  test("agent, group, and service account names are restricted to handle-safe characters", async () => {
    const s = canonical.schema;
    const [owner] = await sql.unsafe(`select uuidv7() as id`);
    const ownerId = owner?.id as string;
    await sql.unsafe(`select ${s}.create_user($1, $2)`, [
      ownerId,
      `owner_${crypto.randomUUID().slice(0, 8)}+alias@example.com`,
    ]);
    const [space] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
      randomSlug(),
      "Name Checks",
    ]);
    const spaceId = space?.id as string;

    for (const ok of ["agent", "agent-v2", "ci_agent", "bot.v2"]) {
      await sql.unsafe(`select ${s}.create_agent($1, $2)`, [ownerId, ok]);
    }

    await sql.unsafe(`select ${s}.create_group($1, $2)`, [
      spaceId,
      "backend-team",
    ]);
    const [adminGroup] = await sql.unsafe(
      `select ${s}.create_group($1, $2) as id`,
      [spaceId, "svc-admins"],
    );
    const adminGroupId = adminGroup?.id as string;

    for (const bad of [
      "alice@example.com",
      "john+bot",
      "team/backend",
      "team admin",
      "-prod",
      ".group",
    ]) {
      await expectReject(() =>
        sql.unsafe(`select ${s}.create_agent($1, $2)`, [ownerId, bad]),
      );
      await expectReject(() =>
        sql.unsafe(`select ${s}.create_group($1, $2)`, [spaceId, bad]),
      );
      await expectReject(() =>
        sql.unsafe(
          `insert into ${s}.principal (kind, name, space_id, admin_id)
           values ('s', $1, $2, $3)`,
          [bad, spaceId, adminGroupId],
        ),
      );
    }
  });

  test("service account principal shape is space-scoped with an admin group", async () => {
    const s = canonical.schema;
    const [space] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
      randomSlug(),
      "Service Account Shape",
    ]);
    const spaceId = space?.id as string;
    const [adminGroup] = await sql.unsafe(
      `select ${s}.create_group($1, $2) as id`,
      [spaceId, "eon-admins"],
    );
    const adminGroupId = adminGroup?.id as string;

    const [svc] = await sql.unsafe(
      `insert into ${s}.principal (kind, name, space_id, admin_id)
       values ('s', 'eon', $1, $2)
       returning id, member_id, space_id, admin_id, user_id, agent_id, group_id`,
      [spaceId, adminGroupId],
    );

    expect(typeof svc?.id).toBe("string");
    expect(svc?.member_id).toBe(svc?.id);
    expect(svc?.space_id).toBe(spaceId);
    expect(svc?.admin_id).toBe(adminGroupId);
    expect(svc?.user_id).toBeNull();
    expect(svc?.agent_id).toBeNull();
    expect(svc?.group_id).toBeNull();

    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.principal (kind, name, space_id, admin_id)
         values ('s', 'same-admin-group', $1, $2)`,
        [spaceId, adminGroupId],
      ),
    );

    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.principal (kind, name, space_id)
         values ('s', 'missing-admin', $1)`,
        [spaceId],
      ),
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.principal (kind, name, admin_id)
         values ('s', 'missing-space', $1)`,
        [adminGroupId],
      ),
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.principal (kind, name, space_id, admin_id)
         values ('s', 'bad-admin', $1, $2)`,
        [spaceId, svc?.id],
      ),
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.principal (kind, name, admin_id)
         values ('u', 'user-admin-id@example.com', $1)`,
        [adminGroupId],
      ),
    );
  });

  test("groups and service accounts share a per-space handle namespace", async () => {
    const s = canonical.schema;
    const [space1] = await sql.unsafe(
      `select ${s}.create_space($1, $2) as id`,
      [randomSlug(), "Service Names 1"],
    );
    const [space2] = await sql.unsafe(
      `select ${s}.create_space($1, $2) as id`,
      [randomSlug(), "Service Names 2"],
    );
    const spaceId1 = space1?.id as string;
    const spaceId2 = space2?.id as string;
    const [adminGroup1] = await sql.unsafe(
      `select ${s}.create_group($1, $2) as id`,
      [spaceId1, "ci-admins"],
    );
    const [adminGroup2] = await sql.unsafe(
      `select ${s}.create_group($1, $2) as id`,
      [spaceId2, "ci-admins"],
    );
    const [adminGroup3] = await sql.unsafe(
      `select ${s}.create_group($1, $2) as id`,
      [spaceId1, "same-cross-space-admins"],
    );

    await sql.unsafe(
      `insert into ${s}.principal (kind, name, space_id, admin_id)
       values ('s', 'ci', $1, $2)`,
      [spaceId1, adminGroup1?.id],
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.principal (kind, name, space_id, admin_id)
         values ('s', 'ci', $1, $2)`,
        [spaceId1, adminGroup1?.id],
      ),
    );
    await expectReject(() =>
      sql.unsafe(`select ${s}.create_group($1, $2)`, [spaceId1, "ci"]),
    );
    await sql.unsafe(`select ${s}.create_group($1, $2)`, [
      spaceId2,
      "same-cross-space",
    ]);
    await sql.unsafe(
      `insert into ${s}.principal (kind, name, space_id, admin_id)
       values ('s', 'same-cross-space', $1, $2)`,
      [spaceId1, adminGroup3?.id],
    );
    await sql.unsafe(
      `insert into ${s}.principal (kind, name, space_id, admin_id)
       values ('s', 'ci', $1, $2)`,
      [spaceId2, adminGroup2?.id],
    );
  });

  test("service accounts can be api-key holders and ordinary group members", async () => {
    const s = canonical.schema;
    const [space] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
      randomSlug(),
      "Service Members",
    ]);
    const spaceId = space?.id as string;
    const [adminGroup] = await sql.unsafe(
      `select ${s}.create_group($1, $2) as id`,
      [spaceId, "svc-key-admins"],
    );
    const [regularGroup] = await sql.unsafe(
      `select ${s}.create_group($1, $2) as id`,
      [spaceId, "bots"],
    );
    const [svc] = await sql.unsafe(
      `insert into ${s}.principal (kind, name, space_id, admin_id)
       values ('s', 'docbot', $1, $2)
       returning id, member_id`,
      [spaceId, adminGroup?.id],
    );
    const serviceId = svc?.id as string;

    await sql.unsafe(`select ${s}.create_api_key($1, $2, $3, $4)`, [
      serviceId,
      "lookupservice001",
      "hashed-secret",
      "service-key",
    ]);
    await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, true)`, [
      spaceId,
      regularGroup?.id,
      serviceId,
    ]);

    const [membership] = await sql.unsafe(
      `select admin from ${s}.group_member where group_id = $1 and member_id = $2`,
      [regularGroup?.id, serviceId],
    );
    expect(membership?.admin).toBe(true);
  });
});

describe("access-control functions are callable", () => {
  // Catches functions that "exist" but reference missing columns/types: a bad
  // body only errors when executed, not when created.
  const dummy = "00000000-0000-7000-8000-000000000000";

  test("access functions execute against empty data", async () => {
    const s = canonical.schema;
    await sql.unsafe(
      `select * from ${s}.user_tree_access('${dummy}', '${dummy}')`,
    );
    await sql.unsafe(
      `select * from ${s}.agent_tree_access('${dummy}', '${dummy}')`,
    );
    await sql.unsafe(
      `select * from ${s}.member_tree_access('${dummy}', '${dummy}')`,
    );
    await sql.unsafe(
      `select * from ${s}.member_groups('${dummy}', '${dummy}')`,
    );
  });

  test("predicate functions return false for unknown principals", async () => {
    const s = canonical.schema;
    const [a] = await sql.unsafe(
      `select ${s}.is_principal_in_space('${dummy}', '${dummy}') as v`,
    );
    expect(a?.v).toBe(false);
    const [b] = await sql.unsafe(
      `select ${s}.is_principal_space_admin('${dummy}', '${dummy}') as v`,
    );
    expect(b?.v).toBe(false);
  });
});

describe("agent_tree_access clamps agent access to its owner", () => {
  // Regression for the `max(x.access)` + `group by tree_path` at the end of
  // agent_tree_access (idempotent/003_tree_access.sql). Setup:
  //
  //   agent grants: foo = owner(3),  foo.bar = read(1)   <- foo.bar is redundant,
  //   owner grants: foo.bar = write(2)                      already covered by foo=3
  //
  // The inner UNION then emits foo.bar twice with different access levels:
  //   * arm 1 keeps the agent's (foo.bar, read)  — the owner's foo.bar covers it
  //   * arm 2 keeps the owner's (foo.bar, write) — the agent's foo covers it
  // Without the trailing max/group-by, agent_tree_access would return foo.bar
  // twice; the effective access is the highest surviving row, (foo.bar, write).
  // `foo` itself never surfaces — the owner grants nothing at or above it.
  test("collapses the two clamp directions into one row per path", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;

      const [space] = await sql.unsafe(
        `insert into ${s}.space (slug, name) values ($1, $2) returning id`,
        [randomSlug(), "clamp"],
      );
      const spaceId = space?.id as string;

      const [owner] = await sql.unsafe(
        `insert into ${s}.principal (kind, name) values ('u', 'owner') returning id`,
      );
      const ownerId = owner?.id as string;

      const [agent] = await sql.unsafe(
        `insert into ${s}.principal (kind, name, owner_id) values ('a', 'agent', $1) returning id`,
        [ownerId],
      );
      const agentId = agent?.id as string;

      // both principals must belong to the space for the access functions to see them
      await sql.unsafe(
        `insert into ${s}.principal_space (space_id, principal_id) values ($1, $2), ($1, $3)`,
        [spaceId, ownerId, agentId],
      );

      await sql.unsafe(
        `insert into ${s}.tree_access (space_id, principal_id, tree_path, access) values
           ($1, $2, 'foo', 3),
           ($1, $2, 'foo.bar', 1),
           ($1, $3, 'foo.bar', 2)`,
        [spaceId, agentId, ownerId],
      );

      const rows = await sql.unsafe(
        `select tree_path::text as tree_path, access
         from ${s}.agent_tree_access($1, $2)
         order by tree_path`,
        [agentId, spaceId],
      );
      const result = rows.map((r) => ({
        tree_path: r.tree_path as string,
        access: r.access as number,
      }));

      // One clamped row, access collapsed to the max of the two union arms.
      expect(result).toEqual([{ tree_path: "foo.bar", access: 2 }]);
    });
  });

  // Resolve an agent's effective (clamped) access given a set of owner grants and
  // a set of agent grants, each as [tree_path, access] tuples. Owner and agent
  // both join the space so the access functions can see them.
  const effectiveAgentAccess = async (
    ownerGrants: [string, number][],
    agentGrants: [string, number][],
  ): Promise<{ tree_path: string; access: number }[]> => {
    let out: { tree_path: string; access: number }[] = [];
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [space] = await sql.unsafe(
        `insert into ${s}.space (slug, name) values ($1, $2) returning id`,
        [randomSlug(), "clamp"],
      );
      const spaceId = space?.id as string;
      const [owner] = await sql.unsafe(
        `insert into ${s}.principal (kind, name) values ('u', 'owner') returning id`,
      );
      const ownerId = owner?.id as string;
      const [agent] = await sql.unsafe(
        `insert into ${s}.principal (kind, name, owner_id) values ('a', 'agent', $1) returning id`,
        [ownerId],
      );
      const agentId = agent?.id as string;
      await sql.unsafe(
        `insert into ${s}.principal_space (space_id, principal_id) values ($1, $2), ($1, $3)`,
        [spaceId, ownerId, agentId],
      );
      const rows: [string, string, string, number][] = [
        ...ownerGrants.map(
          ([p, a]) =>
            [spaceId, ownerId, p, a] as [string, string, string, number],
        ),
        ...agentGrants.map(
          ([p, a]) =>
            [spaceId, agentId, p, a] as [string, string, string, number],
        ),
      ];
      for (const [sp, pr, path, acc] of rows) {
        await sql.unsafe(
          `insert into ${s}.tree_access (space_id, principal_id, tree_path, access) values ($1, $2, $3, $4)`,
          [sp, pr, path, acc],
        );
      }
      const result = await sql.unsafe(
        `select tree_path::text as tree_path, access
         from ${s}.agent_tree_access($1, $2)
         order by tree_path`,
        [agentId, spaceId],
      );
      out = result.map((r) => ({
        tree_path: r.tree_path as string,
        access: r.access as number,
      }));
    });
    return out;
  };

  test("clamps DOWN (not away) when the agent grant exceeds the owner deeper", async () => {
    // TNT-165: owner holds read@foo; the agent is granted write@foo.bar (deeper
    // AND higher). The agent must end up with read@foo.bar — the owner's level —
    // not nothing. (The old exists-based clamp dropped this row entirely.)
    expect(await effectiveAgentAccess([["foo", 1]], [["foo.bar", 2]])).toEqual([
      { tree_path: "foo.bar", access: 1 },
    ]);
  });

  test("a broad agent grant is clamped to the owner's narrower coverage", async () => {
    // owner owns only foo.deep; the agent is granted read across all of foo. The
    // agent is effective only where the owner has coverage — read@foo.deep.
    expect(await effectiveAgentAccess([["foo.deep", 3]], [["foo", 1]])).toEqual(
      [{ tree_path: "foo.deep", access: 1 }],
    );
  });

  test("a grant the owner does not cover at all yields nothing", async () => {
    // owner has access only under bar; an agent grant under foo has no owner
    // coverage on its lineage, so it is dropped.
    expect(await effectiveAgentAccess([["bar", 3]], [["foo", 2]])).toEqual([]);
  });

  test("write@root mirrors the owner's whole footprint, clamped to write", async () => {
    // The agent is granted write at the root (the empty path). Root is an
    // ancestor of every owner grant, so the agent inherits the owner's ENTIRE
    // footprint, each path clamped to least(write, owner): the owner's owner@share
    // becomes write@share, while the owner's read@docs stays read@docs.
    expect(
      await effectiveAgentAccess(
        [
          ["share", 3],
          ["docs", 1],
        ],
        [["", 2]],
      ),
    ).toEqual([
      { tree_path: "docs", access: 1 },
      { tree_path: "share", access: 2 },
    ]);
  });

  test("no escalation across overlapping owner grants", async () => {
    // Owners can hold many overlapping grants (the unique constraint is only on
    // (space, principal, path)): here owner@foo.bar + read@foo + write@foo.bar.baz.
    // The agent holds read@foo. Every covered path must resolve to read — the
    // owner's deeper owner@foo.bar must NOT leak extra access to the agent.
    const result = await effectiveAgentAccess(
      [
        ["foo.bar", 3],
        ["foo", 1],
        ["foo.bar.baz", 2],
      ],
      [["foo", 1]],
    );
    expect(result).toEqual([
      { tree_path: "foo", access: 1 },
      { tree_path: "foo.bar", access: 1 },
      { tree_path: "foo.bar.baz", access: 1 },
    ]);
    // no path resolves above read
    expect(result.every((r) => r.access <= 1)).toBe(true);
  });

  test("an explicit over-grant clamps down to the owner's level", async () => {
    // agent granted owner@foo where the owner only reads foo → clamps to read@foo.
    expect(await effectiveAgentAccess([["foo", 1]], [["foo", 3]])).toEqual([
      { tree_path: "foo", access: 1 },
    ]);
  });

  test("clamps against the owner's group-inherited access (same path, two groups)", async () => {
    // The one case the (space, principal, path) unique constraint doesn't cover:
    // the owner receives the SAME path at two levels via two separate groups
    // (read@foo via g1, write@foo via g2). user_tree_access unions both, so the
    // owner's effective foo is write (the max). An agent granted owner@foo must
    // clamp to write@foo — exercising the union/group path in member_tree_access
    // → user_tree_access that the single-grant tests skip.
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [space] = await sql.unsafe(
        `insert into ${s}.space (slug, name) values ($1, $2) returning id`,
        [randomSlug(), "groups"],
      );
      const spaceId = space?.id as string;
      const [owner] = await sql.unsafe(
        `insert into ${s}.principal (kind, name) values ('u', 'owner') returning id`,
      );
      const ownerId = owner?.id as string;
      const [agent] = await sql.unsafe(
        `insert into ${s}.principal (kind, name, owner_id) values ('a', 'agent', $1) returning id`,
        [ownerId],
      );
      const agentId = agent?.id as string;
      await sql.unsafe(
        `insert into ${s}.principal_space (space_id, principal_id) values ($1, $2), ($1, $3)`,
        [spaceId, ownerId, agentId],
      );

      // two groups the owner belongs to, each granting foo at a different level
      const [g1] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "readers",
      ]);
      const [g2] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "writers",
      ]);
      const g1Id = g1?.id as string;
      const g2Id = g2?.id as string;
      for (const gid of [g1Id, g2Id]) {
        await sql.unsafe(`select ${s}.add_group_member($1, $2, $3)`, [
          spaceId,
          gid,
          ownerId,
        ]);
      }
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        g1Id,
        "foo",
        1,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        g2Id,
        "foo",
        2,
      ]);
      // the agent is granted owner@foo directly
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        agentId,
        "foo",
        3,
      ]);

      const rows = await sql.unsafe(
        `select tree_path::text as tree_path, access
         from ${s}.agent_tree_access($1, $2)
         order by tree_path`,
        [agentId, spaceId],
      );
      // owner's effective foo = max(read, write) = write; the agent clamps to it
      expect(
        rows.map((r) => ({
          tree_path: r.tree_path as string,
          access: r.access as number,
        })),
      ).toEqual([{ tree_path: "foo", access: 2 }]);
    });
  });
});

describe("control-plane functions", () => {
  /** A fresh uuidv7 from the database (principal.id requires version 7). */
  async function v7(): Promise<string> {
    const [row] = await sql.unsafe(`select uuidv7() as id`);
    return row?.id as string;
  }

  /** A principal's canonical home path (mirrors space/path.ts homePrefix). */
  const homePath = (id: string) => `home.${id.replace(/-/g, "")}`;
  /** An agent's home nests under its owner: home.<owner>.<agent>. */
  const agentHomePath = (ownerId: string, agentId: string) =>
    `${homePath(ownerId)}.${agentId.replace(/-/g, "")}`;

  type Grant = { tree_path: string; access: number };

  test("012 backfill: adds a rostered 'team' group + grants for spaces lacking one (idempotent, non-clobbering)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const runBackfill = () =>
        sql.unsafe(template(backfill012, { schema: s }));
      const groupIds = (spaceId: string) =>
        sql.unsafe(
          `select id from ${s}.principal where kind='g' and space_id=$1`,
          [spaceId],
        );
      const grants = async (
        spaceId: string,
        principalId: string,
      ): Promise<Grant[]> => {
        const rows = await sql.unsafe(
          `select tree_path::text as tree_path, access from ${s}.tree_access
             where space_id=$1 and principal_id=$2 order by tree_path`,
          [spaceId, principalId],
        );
        return rows as unknown as Grant[];
      };
      const isRostered = async (spaceId: string, principalId: string) => {
        const [row] = await sql.unsafe(
          `select 1 as ok from ${s}.principal_space
             where space_id=$1 and principal_id=$2`,
          [spaceId, principalId],
        );
        return Boolean(row?.ok);
      };

      // space A: no team group (the common pre-migration state)
      const [a] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Backfill A",
      ]);
      const spaceA = a?.id as string;

      // space B: already has a 'team' group (rostered by create_group) with a
      // NON-standard grant we must keep
      const [b] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Backfill B",
      ]);
      const spaceB = b?.id as string;
      const [gb] = await sql.unsafe(
        `select ${s}.create_group($1, $2, false) as id`,
        [spaceB, "team"],
      );
      const teamB = gb?.id as string;
      await sql.unsafe(
        `select ${s}.grant_tree_access($1, $2, 'share'::ltree, 3)`,
        [spaceB, teamB],
      );

      await runBackfill();

      // A gained a brand-new team group — rostered, with the two standard grants
      const aGroups = await groupIds(spaceA);
      expect(aGroups).toHaveLength(1);
      const teamA = aGroups[0]?.id as string;
      expect(await isRostered(spaceA, teamA)).toBe(true);
      expect(await grants(spaceA, teamA)).toEqual([
        { tree_path: "share", access: 1 },
        { tree_path: "share.projects", access: 2 },
      ]);

      // B's pre-existing team group is left entirely untouched (no second group,
      // its non-standard owner@share grant survives — non-clobbering)
      expect(await groupIds(spaceB)).toHaveLength(1);
      expect(await grants(spaceB, teamB)).toEqual([
        { tree_path: "share", access: 3 },
      ]);

      // re-running is a no-op: no duplicate groups or grants
      await runBackfill();
      expect(await groupIds(spaceA)).toHaveLength(1);
      expect(await grants(spaceA, teamA)).toHaveLength(2);
    });
  });

  test("create_space + create_user + grant → build_tree_access returns the search_memory jsonb shape", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Test Space",
      ]);
      const spaceId = sp?.id as string;

      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2) as id`, [
        userId,
        "alice",
      ]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        userId,
        true,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        userId,
        "work.projects",
        2,
      ]);

      const [row] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [userId, spaceId],
      );
      const ta = row?.ta as Grant[];
      // add_principal_to_space also grants the user owner@home; the explicit
      // grant adds to it.
      expect(ta).toContainEqual({ tree_path: "work.projects", access: 2 });
      expect(ta).toContainEqual({ tree_path: homePath(userId), access: 3 });
      expect(ta).toHaveLength(2);
    });
  });

  test("add_principal_to_space grants owner@home to users and agents (nested), idempotently; not groups or service accounts", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Homes",
      ]);
      const spaceId = sp?.id as string;

      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "homer"]);
      const agentId = await v7();
      await sql.unsafe(`select ${s}.create_agent($1, $2, $3)`, [
        userId, // owner
        `agent_${randomSlug()}`, // name
        agentId, // id
      ]);
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        `grp_${randomSlug()}`,
      ]);
      const groupId = grp?.id as string;
      const [svc] = await sql.unsafe(
        `select id from ${s}.create_service_account($1, $2)`,
        [spaceId, `svc_${randomSlug()}`],
      );
      const serviceId = svc?.id as string;

      // add each twice to prove the home grant is idempotent
      for (const id of [userId, agentId, groupId, serviceId]) {
        await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
          spaceId,
          id,
          false,
        ]);
        await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
          spaceId,
          id,
          false,
        ]);
      }

      const grants = async (id: string): Promise<Grant[]> => {
        const rows = await sql.unsafe(
          `select tree_path::text, access from ${s}.tree_access
           where space_id = $1 and principal_id = $2`,
          [spaceId, id],
        );
        return rows as unknown as Grant[];
      };
      // the user gets exactly one owner@home grant (not duplicated by re-add)
      expect(await grants(userId)).toEqual([
        { tree_path: homePath(userId), access: 3 },
      ]);
      // the agent gets owner@home nested under its owner (covered by the owner's
      // home grant, so agent_tree_access keeps it); groups and service accounts
      // have no home
      expect(await grants(agentId)).toEqual([
        { tree_path: agentHomePath(userId, agentId), access: 3 },
      ]);
      expect(await grants(groupId)).toEqual([]);
      expect(await grants(serviceId)).toEqual([]);

      // the agent's nested home is EFFECTIVE (not clamped to nothing): the
      // owner holds owner@home.<owner>, which covers home.<owner>.<agent>.
      const [agentTa] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [agentId, spaceId],
      );
      expect(agentTa?.ta as Grant[]).toEqual([
        { tree_path: agentHomePath(userId, agentId), access: 3 },
      ]);
    });
  });

  test("add_principal_to_space suppresses owner@home when the space has auto_grant_home=false", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      // custom space: auto_grant_home = false (4th create_space arg)
      const [sp] = await sql.unsafe(
        `select ${s}.create_space($1, $2, $3, $4) as id`,
        [randomSlug(), "Custom", "english", false],
      );
      const spaceId = sp?.id as string;

      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "no-home"]);
      const agentId = await v7();
      await sql.unsafe(`select ${s}.create_agent($1, $2, $3)`, [
        userId,
        `agent_${randomSlug()}`,
        agentId,
      ]);

      for (const id of [userId, agentId]) {
        await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
          spaceId,
          id,
          false,
        ]);
      }

      const grants = async (id: string): Promise<Grant[]> => {
        const rows = await sql.unsafe(
          `select tree_path::text, access from ${s}.tree_access
           where space_id = $1 and principal_id = $2`,
          [spaceId, id],
        );
        return rows as unknown as Grant[];
      };
      // neither the user nor the agent gets an owner@home grant
      expect(await grants(userId)).toEqual([]);
      expect(await grants(agentId)).toEqual([]);
    });
  });

  test("create_service_account creates an inert service account and bound admin group", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Service Create",
      ]);
      const spaceId = sp?.id as string;
      const memberId = await v7();
      const groupAdminId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        memberId,
        "svc-member@example.com",
      ]);
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        groupAdminId,
        "svc-group-admin@example.com",
      ]);
      const [agent] = await sql.unsafe(
        `select ${s}.create_agent($1, $2) as id`,
        [memberId, `svc_agent_${randomSlug()}`],
      );
      const agentId = agent?.id as string;
      const [memberService] = await sql.unsafe(
        `select * from ${s}.create_service_account($1, $2, $3::uuid[], $4::uuid[])`,
        [spaceId, "helper", [], []],
      );
      const memberServiceId = memberService?.id as string;

      const [svc] = await sql.unsafe(
        `select * from ${s}.create_service_account($1, $2, $3::uuid[], $4::uuid[])`,
        [spaceId, "eon", [memberId, agentId], [groupAdminId, memberServiceId]],
      );
      const serviceId = svc?.id as string;
      const adminGroupId = svc?.admin_id as string;
      expect(serviceId).toBeTruthy();
      expect(adminGroupId).toBeTruthy();

      const [service] = await sql.unsafe(
        `select kind, name::text, space_id, admin_id, member_id from ${s}.principal where id = $1`,
        [serviceId],
      );
      expect(service).toMatchObject({
        kind: "s",
        name: "eon",
        space_id: spaceId,
        admin_id: adminGroupId,
        member_id: serviceId,
      });
      const [adminGroup] = await sql.unsafe(
        `select kind, name::text, space_id, is_default_group from ${s}.principal where id = $1`,
        [adminGroupId],
      );
      expect(adminGroup).toMatchObject({
        kind: "g",
        name: "eon-admin",
        space_id: spaceId,
        is_default_group: false,
      });

      const roster = await sql.unsafe(
        `select principal_id, admin from ${s}.principal_space
         where space_id = $1 and principal_id in ($2, $3)
         order by principal_id`,
        [spaceId, serviceId, adminGroupId],
      );
      expect(roster).toHaveLength(2);
      expect(roster.every((r) => r.admin === false)).toBe(true);

      const members = await sql.unsafe(
        `select member_id, admin from ${s}.group_member
         where space_id = $1 and group_id = $2 order by member_id`,
        [spaceId, adminGroupId],
      );
      const normalizedMembers = members.map((r) => ({
        member_id: r.member_id as string,
        admin: r.admin as boolean,
      }));
      expect(normalizedMembers).toContainEqual({
        member_id: memberId,
        admin: false,
      });
      expect(normalizedMembers).toContainEqual({
        member_id: groupAdminId,
        admin: true,
      });
      expect(normalizedMembers).toContainEqual({
        member_id: agentId,
        admin: false,
      });
      expect(normalizedMembers).toContainEqual({
        member_id: memberServiceId,
        admin: true,
      });

      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, false)`, [
        spaceId,
        memberId,
      ]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, false)`, [
        spaceId,
        agentId,
      ]);
      const [userAdmin] = await sql.unsafe(
        `select ${s}.is_service_account_admin($1, $2) as ok`,
        [serviceId, memberId],
      );
      const [agentAdmin] = await sql.unsafe(
        `select ${s}.is_service_account_admin($1, $2) as ok`,
        [serviceId, agentId],
      );
      const [serviceAdmin] = await sql.unsafe(
        `select ${s}.is_service_account_admin($1, $2) as ok`,
        [serviceId, memberServiceId],
      );
      expect(userAdmin?.ok).toBe(true);
      expect(agentAdmin?.ok).toBe(false);
      expect(serviceAdmin?.ok).toBe(false);

      const [helper] = await sql.unsafe(
        `select ${s}.service_account_for_admin_group($1) as id`,
        [adminGroupId],
      );
      expect(helper?.id).toBe(serviceId);

      const [grantCount] = await sql.unsafe(
        `select count(*)::int as n from ${s}.tree_access where principal_id = $1`,
        [serviceId],
      );
      expect(grantCount?.n).toBe(0);
      const [defaultMembership] = await sql.unsafe(
        `select count(*)::int as n from ${s}.group_member where member_id = $1`,
        [serviceId],
      );
      expect(defaultMembership?.n).toBe(0);

      await sql.unsafe(`select ${s}.create_api_key($1, $2, $3, $4)`, [
        serviceId,
        "lookupservice002",
        "hashed-secret",
        "service-key",
      ]);
      const [validated] = await sql.unsafe(
        `select * from ${s}.validate_api_key($1, $2)`,
        ["lookupservice002", "hashed-secret"],
      );
      expect(validated?.member_id).toBe(serviceId);
      expect(validated?.owner_id).toBeNull();
    });
  });

  test("create_service_account reports derived admin-group name collisions clearly", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Service Collision",
      ]);
      const spaceId = sp?.id as string;
      const prefix = "a".repeat(94);
      const firstName = `${prefix}111111`;
      const secondName = `${prefix}222222`;

      await sql.unsafe(
        `select * from ${s}.create_service_account($1, $2, $3::uuid[], $4::uuid[])`,
        [spaceId, firstName, [], []],
      );

      let error: unknown;
      try {
        await sql.unsafe(
          `select * from ${s}.create_service_account($1, $2, $3::uuid[], $4::uuid[])`,
          [spaceId, secondName, [], []],
        );
      } catch (e) {
        error = e;
      }

      expect(error).toBeTruthy();
      expect(String((error as Error).message)).toContain(
        `derived admin group name ${prefix}-admin already exists in this space`,
      );
    });
  });

  test("service-account admin groups are protected and deleted with the service account", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Service Protect",
      ]);
      const spaceId = sp?.id as string;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        userId,
        "svc-admin@example.com",
      ]);
      const [agent] = await sql.unsafe(
        `select ${s}.create_agent($1, $2) as id`,
        [userId, `svc_agent_${randomSlug()}`],
      );
      const agentId = agent?.id as string;
      const [svc] = await sql.unsafe(
        `select * from ${s}.create_service_account($1, $2, $3::uuid[], $4::uuid[])`,
        [spaceId, "ci", [userId], []],
      );
      const serviceId = svc?.id as string;
      const adminGroupId = svc?.admin_id as string;

      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, false)`, [
        spaceId,
        agentId,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, false)`, [
        spaceId,
        adminGroupId,
        agentId,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, false)`, [
        spaceId,
        adminGroupId,
        serviceId,
      ]);
      await expectReject(() =>
        sql.unsafe(`select ${s}.set_group_is_space_admin($1, $2, true)`, [
          spaceId,
          adminGroupId,
        ]),
      );
      await expectReject(() =>
        sql.unsafe(
          `update ${s}.principal_space set admin = true where principal_id = $1 and space_id = $2`,
          [adminGroupId, spaceId],
        ),
      );
      await expectReject(() =>
        sql.unsafe(
          `update ${s}.principal set is_default_group = true where id = $1`,
          [adminGroupId],
        ),
      );
      await expectReject(() =>
        sql.unsafe(`select ${s}.delete_principal($1)`, [adminGroupId]),
      );

      await sql.unsafe(
        `select ${s}.grant_tree_access($1, $2, 'share'::ltree, 1)`,
        [spaceId, adminGroupId],
      );
      const [deleted] = await sql.unsafe(
        `select ${s}.delete_principal($1) as ok`,
        [serviceId],
      );
      expect(deleted?.ok).toBe(true);

      for (const id of [serviceId, adminGroupId]) {
        const [principal] = await sql.unsafe(
          `select count(*)::int as n from ${s}.principal where id = $1`,
          [id],
        );
        expect(principal?.n).toBe(0);
        const [roster] = await sql.unsafe(
          `select count(*)::int as n from ${s}.principal_space where principal_id = $1`,
          [id],
        );
        expect(roster?.n).toBe(0);
        const [grants] = await sql.unsafe(
          `select count(*)::int as n from ${s}.tree_access where principal_id = $1`,
          [id],
        );
        expect(grants?.n).toBe(0);
      }
      const [groupMembers] = await sql.unsafe(
        `select count(*)::int as n from ${s}.group_member where group_id = $1`,
        [adminGroupId],
      );
      expect(groupMembers?.n).toBe(0);
    });
  });

  test("service accounts can administer ordinary groups but do not inherit space admin via groups", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Service Group Admin",
      ]);
      const spaceId = sp?.id as string;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        userId,
        "ordinary-admin@example.com",
      ]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, false)`, [
        spaceId,
        userId,
      ]);
      const [svc] = await sql.unsafe(
        `select id from ${s}.create_service_account($1, $2)`,
        [spaceId, "provisioner"],
      );
      const serviceId = svc?.id as string;
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "operators",
      ]);
      const groupId = grp?.id as string;

      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, true)`, [
        spaceId,
        groupId,
        serviceId,
      ]);
      const [groupAdmin] = await sql.unsafe(
        `select ${s}.is_group_admin($1, $2, $3) as ok`,
        [serviceId, groupId, spaceId],
      );
      expect(groupAdmin?.ok).toBe(true);

      await sql.unsafe(`select ${s}.set_group_is_space_admin($1, $2, true)`, [
        spaceId,
        groupId,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, false)`, [
        spaceId,
        groupId,
        userId,
      ]);

      const [userSpaceAdmin] = await sql.unsafe(
        `select ${s}.is_principal_space_admin($1, $2) as ok`,
        [userId, spaceId],
      );
      expect(userSpaceAdmin?.ok).toBe(true);
      const [serviceInheritedAdmin] = await sql.unsafe(
        `select ${s}.is_principal_space_admin($1, $2) as ok`,
        [serviceId, spaceId],
      );
      expect(serviceInheritedAdmin?.ok).toBe(false);

      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, true)`, [
        spaceId,
        serviceId,
      ]);
      const [serviceDirectAdmin] = await sql.unsafe(
        `select ${s}.is_principal_space_admin($1, $2) as ok`,
        [serviceId, spaceId],
      );
      expect(serviceDirectAdmin?.ok).toBe(true);
    });
  });

  test("014 backfill semantics: flags each space's existing 'team' group as its default", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      // a space with a 'team' group NOT yet flagged (the pre-014 state;
      // create_group defaults is_default_group=false)
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Backfill",
      ]);
      const spaceId = sp?.id as string;
      const [g] = await sql.unsafe(
        `select ${s}.create_group($1, $2, false) as id`,
        [spaceId, "team"],
      );
      const teamId = g?.id as string;
      // and a non-team group that must NOT be flagged
      const [og] = await sql.unsafe(
        `select ${s}.create_group($1, $2, false) as id`,
        [spaceId, `other_${randomSlug()}`],
      );
      const otherId = og?.id as string;

      const isDefault = async (id: string) => {
        const [row] = await sql.unsafe(
          `select is_default_group from ${s}.principal where id = $1`,
          [id],
        );
        return Boolean(row?.is_default_group);
      };
      expect(await isDefault(teamId)).toBe(false);

      // the backfill's data step (the DDL from 014 already ran in migrateCore)
      await sql.unsafe(
        `update ${s}.principal set is_default_group = true
         where group_id is not null and name = 'team'`,
      );

      expect(await isDefault(teamId)).toBe(true);
      expect(await isDefault(otherId)).toBe(false);

      // the partial-unique index (from 014) rejects a second default group
      await expectReject(() =>
        sql.unsafe(
          `select ${s}.create_group($1, $2, false, null, true) as id`,
          [spaceId, `dup_${randomSlug()}`],
        ),
      );
    });
  });

  test("principal.is_default_group is restricted to groups (check constraint)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        userId,
        "not-a-grp",
      ]);

      // flagging a non-group principal violates principal_default_group_is_group_check
      await expectReject(() =>
        sql.unsafe(
          `update ${s}.principal set is_default_group = true where id = $1`,
          [userId],
        ),
      );
    });
  });

  test("add_principal_to_space rejects adding a group to a foreign space", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [home] = await sql.unsafe(
        `select ${s}.create_space($1, $2) as id`,
        [randomSlug(), "Home"],
      );
      const homeSpace = home?.id as string;
      const [other] = await sql.unsafe(
        `select ${s}.create_space($1, $2) as id`,
        [randomSlug(), "Other"],
      );
      const otherSpace = other?.id as string;
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        homeSpace,
        `grp_${randomSlug()}`,
      ]);
      const groupId = grp?.id as string;

      // adding the group to a space other than the one it was created in is
      // rejected with a check-violation SQLSTATE (mapped to VALIDATION_ERROR)
      let code: string | undefined;
      try {
        await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
          otherSpace,
          groupId,
          false,
        ]);
        throw new Error("expected add to a foreign space to reject");
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("23514");

      // adding it to its own space still works
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        homeSpace,
        groupId,
        true,
      ]);
      const [row] = await sql.unsafe(
        `select admin from ${s}.principal_space where space_id = $1 and principal_id = $2`,
        [homeSpace, groupId],
      );
      expect(row?.admin).toBe(true);
    });
  });

  test("build_tree_access includes access granted via a group", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Team Space",
      ]);
      const spaceId = sp?.id as string;

      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2) as id`, [
        userId,
        "bob",
      ]);
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "engineering",
      ]);
      const groupId = grp?.id as string;

      // both the user and the group must be members of the space
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        userId,
        false,
      ]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        groupId,
        false,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, $4)`, [
        spaceId,
        groupId,
        userId,
        false,
      ]);
      // grant to the GROUP, not the user
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        groupId,
        "shared.docs",
        1,
      ]);

      const [row] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [userId, spaceId],
      );
      const ta = row?.ta as Grant[];
      expect(ta).toContainEqual({ tree_path: "shared.docs", access: 1 });
    });
  });

  test("build_tree_access resolves service-account direct and ordinary-group grants without an owner clamp", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Service Access",
      ]);
      const spaceId = sp?.id as string;
      const [svc] = await sql.unsafe(
        `select * from ${s}.create_service_account($1, $2)`,
        [spaceId, "importer"],
      );
      const serviceId = svc?.id as string;
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "automation",
      ]);
      const groupId = grp?.id as string;

      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        serviceId,
        "private.docs",
        3,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, false)`, [
        spaceId,
        groupId,
        serviceId,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        groupId,
        "shared.docs",
        1,
      ]);

      const [row] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [serviceId, spaceId],
      );
      const ta = row?.ta as Grant[];
      expect(ta).toContainEqual({ tree_path: "private.docs", access: 3 });
      expect(ta).toContainEqual({ tree_path: "shared.docs", access: 1 });
      expect(ta).toHaveLength(2);
    });
  });

  test("service-account admin-group grants accrue only after explicit membership", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Service Admin Group Access",
      ]);
      const spaceId = sp?.id as string;
      const [svc] = await sql.unsafe(
        `select * from ${s}.create_service_account($1, $2)`,
        [spaceId, "eon"],
      );
      const serviceId = svc?.id as string;
      const adminGroupId = svc?.admin_id as string;

      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        adminGroupId,
        "admin.only",
        3,
      ]);

      const [row] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [serviceId, spaceId],
      );
      expect(row?.ta).toEqual([]);

      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, false)`, [
        spaceId,
        adminGroupId,
        serviceId,
      ]);
      const [afterJoin] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [serviceId, spaceId],
      );
      expect(afterJoin?.ta as Grant[]).toContainEqual({
        tree_path: "admin.only",
        access: 3,
      });
    });
  });

  test("remove_group_member revokes group-inherited access", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Team",
      ]);
      const spaceId = sp?.id as string;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "erin"]);
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "ops",
      ]);
      const groupId = grp?.id as string;
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        userId,
        false,
      ]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        groupId,
        false,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, $4)`, [
        spaceId,
        groupId,
        userId,
        false,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        groupId,
        "team.notes",
        2,
      ]);

      // sanity: access is inherited via the group
      const [before] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [userId, spaceId],
      );
      expect(before?.ta as Grant[]).toContainEqual({
        tree_path: "team.notes",
        access: 2,
      });

      const [removed] = await sql.unsafe(
        `select ${s}.remove_group_member($1, $2, $3) as removed`,
        [spaceId, groupId, userId],
      );
      expect(removed?.removed).toBe(true);

      const [after] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [userId, spaceId],
      );
      // still a space member (only left the group): the group grant is gone,
      // but the user keeps its own home.
      expect(after?.ta).toEqual([{ tree_path: homePath(userId), access: 3 }]);

      // second remove is a no-op
      const [again] = await sql.unsafe(
        `select ${s}.remove_group_member($1, $2, $3) as removed`,
        [spaceId, groupId, userId],
      );
      expect(again?.removed).toBe(false);
    });
  });

  test("remove_principal_from_space cascades grants + group memberships (space-scoped)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Cascade",
      ]);
      const spaceId = sp?.id as string;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "frank"]);
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "team",
      ]);
      const groupId = grp?.id as string;

      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        userId,
        false,
      ]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        groupId,
        false,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, $4)`, [
        spaceId,
        groupId,
        userId,
        false,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        userId,
        "direct",
        2,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        groupId,
        "shared",
        1,
      ]);

      const [removed] = await sql.unsafe(
        `select ${s}.remove_principal_from_space($1, $2) as removed`,
        [spaceId, userId],
      );
      expect(removed?.removed).toBe(true);

      const count = async (table: string, col: string, id: string) => {
        const [r] = await sql.unsafe(
          `select count(*)::int as n from ${s}.${table} where space_id=$1 and ${col}=$2`,
          [spaceId, id],
        );
        return Number(r?.n);
      };
      // the user's membership, direct grant, and group membership are all gone
      expect(await count("principal_space", "principal_id", userId)).toBe(0);
      expect(await count("tree_access", "principal_id", userId)).toBe(0);
      expect(await count("group_member", "member_id", userId)).toBe(0);
      // the group itself and its own grant are untouched
      expect(await count("principal_space", "principal_id", groupId)).toBe(1);
      expect(await count("tree_access", "principal_id", groupId)).toBe(1);
    });
  });

  test("remove_principal_from_space rejects service accounts", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Service Remove",
      ]);
      const spaceId = sp?.id as string;
      const [svc] = await sql.unsafe(
        `select * from ${s}.create_service_account($1, $2, $3::uuid[], $4::uuid[])`,
        [spaceId, "deploy", [], []],
      );
      const serviceId = svc?.id as string;
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceId,
        "robots",
      ]);
      const groupId = grp?.id as string;
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        serviceId,
        "deploy.logs",
        2,
      ]);
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, $4)`, [
        spaceId,
        groupId,
        serviceId,
        false,
      ]);

      let error: unknown;
      try {
        await sql.unsafe(
          `select ${s}.remove_principal_from_space($1, $2) as removed`,
          [spaceId, serviceId],
        );
      } catch (e) {
        error = e;
      }

      expect(error).toBeTruthy();
      expect(String((error as Error).message)).toContain(
        "delete the service account instead",
      );

      const count = async (table: string, col: string, id: string) => {
        const [r] = await sql.unsafe(
          `select count(*)::int as n from ${s}.${table} where space_id=$1 and ${col}=$2`,
          [spaceId, id],
        );
        return Number(r?.n);
      };
      expect(await count("principal_space", "principal_id", serviceId)).toBe(1);
      expect(await count("tree_access", "principal_id", serviceId)).toBe(1);
      expect(await count("group_member", "member_id", serviceId)).toBe(1);
    });
  });

  test("remove_principal_from_space cascades a user's owned agents (space-scoped)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp1] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "One",
      ]);
      const [sp2] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Two",
      ]);
      const space1 = sp1?.id as string;
      const space2 = sp2?.id as string;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "frank"]);

      // agent1 lives in space1 (with a grant + group membership); agent2 in space2.
      const [a1] = await sql.unsafe(`select ${s}.create_agent($1, $2) as id`, [
        userId,
        "agent-one",
      ]);
      const [a2] = await sql.unsafe(`select ${s}.create_agent($1, $2) as id`, [
        userId,
        "agent-two",
      ]);
      const agent1 = a1?.id as string;
      const agent2 = a2?.id as string;

      // roster the user + agent1 into space1
      for (const id of [userId, agent1]) {
        await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
          space1,
          id,
          false,
        ]);
      }
      // agent1 gets a grant and a group membership in space1
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        space1,
        "team",
      ]);
      const groupId = grp?.id as string;
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, $4)`, [
        space1,
        groupId,
        agent1,
        false,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        space1,
        agent1,
        "share",
        2,
      ]);

      // agent2 is rostered into space2 (a different space); the join grants it
      // owner over its home directory (the one tree_access row we assert stays).
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        space2,
        agent2,
        false,
      ]);

      const [removed] = await sql.unsafe(
        `select ${s}.remove_principal_from_space($1, $2) as removed`,
        [space1, userId],
      );
      expect(removed?.removed).toBe(true);

      const count = async (
        table: string,
        col: string,
        id: string,
        spaceId: string,
      ) => {
        const [r] = await sql.unsafe(
          `select count(*)::int as n from ${s}.${table} where space_id=$1 and ${col}=$2`,
          [spaceId, id],
        );
        return Number(r?.n);
      };

      // agent1 is fully deprovisioned from space1: membership, grant, group row
      expect(
        await count("principal_space", "principal_id", agent1, space1),
      ).toBe(0);
      expect(await count("tree_access", "principal_id", agent1, space1)).toBe(
        0,
      );
      expect(await count("group_member", "member_id", agent1, space1)).toBe(0);

      // but agent1's `principal` row itself survives (it was not deleted)
      const [pr] = await sql.unsafe(
        `select count(*)::int as n from ${s}.principal where id=$1`,
        [agent1],
      );
      expect(Number(pr?.n)).toBe(1);

      // agent2 in the OTHER space is untouched (membership + its home grant)
      expect(
        await count("principal_space", "principal_id", agent2, space2),
      ).toBe(1);
      expect(await count("tree_access", "principal_id", agent2, space2)).toBe(
        1,
      );
    });
  });

  test("group_member.space_id is pinned to the group's space (composite FK)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [a] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "A",
      ]);
      const [b] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "B",
      ]);
      const spaceA = a?.id as string;
      const spaceB = b?.id as string;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "frank"]);
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceA,
        "team",
      ]);
      const groupId = grp?.id as string;

      // the group belongs to space A; tagging a membership with space B is
      // rejected by the composite FK (group_id, space_id) -> principal(...)
      await expectReject(() =>
        sql.unsafe(`select ${s}.add_group_member($1, $2, $3, $4)`, [
          spaceB,
          groupId,
          userId,
          false,
        ]),
      );

      // the group's own space works
      await sql.unsafe(`select ${s}.add_group_member($1, $2, $3, $4)`, [
        spaceA,
        groupId,
        userId,
        false,
      ]);
    });
  });

  test("a group's principal_space row is pinned to its own space (coherence trigger)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [a] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "A",
      ]);
      const [b] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "B",
      ]);
      const spaceA = a?.id as string;
      const spaceB = b?.id as string;
      // create_group rosters the group into space A (admin=false)
      const [grp] = await sql.unsafe(`select ${s}.create_group($1, $2) as id`, [
        spaceA,
        "team",
      ]);
      const groupId = grp?.id as string;

      // a DIRECT insert that bypasses add_principal_to_space's guard, rostering
      // the (space A) group into space B, is rejected by the coherence trigger
      // (the half of the invariant that can't be a composite FK).
      await expectReject(() =>
        sql.unsafe(
          `insert into ${s}.principal_space (space_id, principal_id, admin)
           values ($1, $2, false)`,
          [spaceB, groupId],
        ),
      );

      // a direct insert into the group's OWN space is fine (idempotent upsert
      // target already exists, so use a conflict-free no-op check instead)
      const [ok] = await sql.unsafe(
        `select count(*)::int as n from ${s}.principal_space
         where principal_id = $1 and space_id = $2`,
        [groupId, spaceA],
      );
      expect(Number(ok?.n)).toBe(1);
    });
  });

  test("remove_tree_access_grant drops the grant", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Sp",
      ]);
      const spaceId = sp?.id as string;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "carol"]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        userId,
        false,
      ]);
      await sql.unsafe(`select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`, [
        spaceId,
        userId,
        "a.b",
        3,
      ]);

      const [first] = await sql.unsafe(
        `select ${s}.remove_tree_access_grant($1, $2, $3::ltree) as removed`,
        [spaceId, userId, "a.b"],
      );
      expect(first?.removed).toBe(true);
      const [second] = await sql.unsafe(
        `select ${s}.remove_tree_access_grant($1, $2, $3::ltree) as removed`,
        [spaceId, userId, "a.b"],
      );
      expect(second?.removed).toBe(false);

      const [row] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [userId, spaceId],
      );
      // the explicit a.b grant is gone; the user keeps its own home.
      expect(row?.ta).toEqual([{ tree_path: homePath(userId), access: 3 }]);
    });
  });

  test("space invitations: create (upsert) / list / accept (join + home + share) / decline / revoke", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Invites",
      ]);
      const spaceId = sp?.id as string;

      // inviter must exist as a principal (invited_by FK)
      const inviterId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        inviterId,
        "inviter@example.com",
      ]);

      const email = "invitee@example.com";
      // Two groups with different shared-tree grants: an invite adds its redeemer
      // to a group, and the joiner inherits that group's grants.
      const [gr] = await sql.unsafe(
        `select ${s}.create_group($1, $2, false) as id`,
        [spaceId, "readers"],
      );
      const readers = gr?.id as string;
      await sql.unsafe(
        `select ${s}.grant_tree_access($1, $2, 'share'::ltree, 1)`,
        [spaceId, readers],
      );
      const [go] = await sql.unsafe(
        `select ${s}.create_group($1, $2, false) as id`,
        [spaceId, "owners"],
      );
      const owners = go?.id as string;
      await sql.unsafe(
        `select ${s}.grant_tree_access($1, $2, 'share'::ltree, 3)`,
        [spaceId, owners],
      );

      // Each invite needs a distinct token (partial unique index).
      let tok = 0;
      const create = (admin: boolean, groupIds: string[]) =>
        sql.unsafe(
          `select ${s}.create_space_invitation($1, $2, $3, $4::uuid[], $5, $6, $7, $8) as id`,
          [
            spaceId,
            email,
            admin,
            groupIds,
            inviterId,
            `inv.tok_${tok++}`,
            null,
            null,
          ],
        );

      // create (readers group, not admin), then re-create promotes the SAME
      // pending row to admin + the owners group (upsert, not a duplicate)
      const [c1] = await create(false, [readers]);
      const inviteId = c1?.id as string;
      expect(inviteId).toBeTruthy();
      const [c2] = await create(true, [owners]);
      expect(c2?.id).toBe(inviteId);

      // list: one pending invite with the updated fields + the inviter's name
      const listed = await sql.unsafe(
        `select * from ${s}.list_space_invitations($1)`,
        [spaceId],
      );
      expect(listed).toHaveLength(1);
      expect(listed[0]?.email).toBe(email);
      expect(listed[0]?.admin).toBe(true);
      expect(listed[0]?.group_ids).toEqual([owners]);
      expect(listed[0]?.group_names).toEqual(["owners"]);
      expect(listed[0]?.invited_by_name).toBe("inviter@example.com");

      // the invitee registers; the invite appears in their email-keyed list
      // (email match is case-insensitive)
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, email]);
      const forEmail = await sql.unsafe(
        `select * from ${s}.list_pending_invitations_for_email($1)`,
        ["INVITEE@EXAMPLE.COM"],
      );
      expect(forEmail).toHaveLength(1);
      expect(forEmail[0]?.invitation_id).toBe(inviteId);
      expect(forEmail[0]?.space_id).toBe(spaceId);
      expect(forEmail[0]?.invited_by_name).toBe("inviter@example.com");

      // accept gated on email: a mismatched email accepts nothing
      const mismatch = await sql.unsafe(
        `select * from ${s}.accept_space_invitation($1, $2, $3)`,
        [userId, "someone-else@example.com", inviteId],
      );
      expect(mismatch).toHaveLength(0);

      // accept by id (email match is case-insensitive)
      const accepted = await sql.unsafe(
        `select * from ${s}.accept_space_invitation($1, $2, $3)`,
        [userId, "INVITEE@EXAMPLE.COM", inviteId],
      );
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.space_id).toBe(spaceId);
      expect(accepted[0]?.admin).toBe(true);
      expect(accepted[0]?.group_names).toEqual(["owners"]);

      // accepting records a redemption row too (same audit as redeem_invitation)
      const [red] = await sql.unsafe(
        `select count(*)::int as n from ${s}.space_invitation_redemption
         where invitation_id = $1 and user_id = $2`,
        [inviteId, userId],
      );
      expect(red?.n).toBe(1);

      // joined as admin, with owner@home (add_principal_to_space) + owner@share
      // (inherited from the owners group)
      const [ps] = await sql.unsafe(
        `select admin from ${s}.principal_space where space_id=$1 and principal_id=$2`,
        [spaceId, userId],
      );
      expect(ps?.admin).toBe(true);
      const [taRow] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [userId, spaceId],
      );
      const ta = taRow?.ta as Grant[];
      expect(ta).toContainEqual({ tree_path: homePath(userId), access: 3 });
      expect(ta).toContainEqual({ tree_path: "share", access: 3 });

      // accepted: gone from both lists, and re-accept is a no-op
      expect(
        await sql.unsafe(`select * from ${s}.list_space_invitations($1)`, [
          spaceId,
        ]),
      ).toHaveLength(0);
      expect(
        await sql.unsafe(
          `select * from ${s}.list_pending_invitations_for_email($1)`,
          [email],
        ),
      ).toHaveLength(0);
      expect(
        await sql.unsafe(
          `select * from ${s}.accept_space_invitation($1, $2, $3)`,
          [userId, email, inviteId],
        ),
      ).toHaveLength(0);

      // decline gated on email: a fresh invite is declinable by the invitee once
      const [d0] = await create(false, [readers]);
      const declineId = d0?.id as string;
      const [dMismatch] = await sql.unsafe(
        `select ${s}.decline_space_invitation($1, $2) as ok`,
        ["someone-else@example.com", declineId],
      );
      expect(dMismatch?.ok).toBe(false);
      const [d1] = await sql.unsafe(
        `select ${s}.decline_space_invitation($1, $2) as ok`,
        [email, declineId],
      );
      expect(d1?.ok).toBe(true);
      const [d2] = await sql.unsafe(
        `select ${s}.decline_space_invitation($1, $2) as ok`,
        [email, declineId],
      );
      expect(d2?.ok).toBe(false);

      // decline is a SOFT delete: the row persists (declined_at stamped) for
      // audit, drops off the invitee's list, and frees the email to be re-invited.
      const [declinedRow] = await sql.unsafe(
        `select declined_at from ${s}.space_invitation where id = $1`,
        [declineId],
      );
      expect(declinedRow?.declined_at).not.toBeNull();
      expect(
        await sql.unsafe(
          `select * from ${s}.list_pending_invitations_for_email($1)`,
          [email],
        ),
      ).toHaveLength(0);

      // revoke: re-inviting the (now declined) email creates a fresh active row,
      // revocable by the admin once (also a soft delete).
      await create(false, [readers]);
      const [r1] = await sql.unsafe(
        `select ${s}.revoke_space_invitation($1, $2) as ok`,
        [spaceId, email],
      );
      expect(r1?.ok).toBe(true);
      const [r2] = await sql.unsafe(
        `select ${s}.revoke_space_invitation($1, $2) as ok`,
        [spaceId, email],
      );
      expect(r2?.ok).toBe(false);
    });
  });

  test("magic links: redeem_invitation (open multi-use, email-constrained, max_uses, revoke)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Links",
      ]);
      const spaceId = sp?.id as string;
      const inviterId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        inviterId,
        "inviter@example.com",
      ]);

      const mkUser = async (email: string) => {
        const id = await v7();
        await sql.unsafe(`select ${s}.create_user($1, $2)`, [id, email]);
        return id;
      };
      const redeem = (token: string, uid: string, em: string | null) =>
        sql.unsafe(`select * from ${s}.redeem_invitation($1, $2, $3)`, [
          token,
          uid,
          em,
        ]);

      // the group every invite in this test adds its redeemer to
      const [grp] = await sql.unsafe(
        `select ${s}.create_group($1, $2, false) as id`,
        [spaceId, "team"],
      );
      const groupId = grp?.id as string;
      await sql.unsafe(
        `select ${s}.grant_tree_access($1, $2, 'share'::ltree, 1)`,
        [spaceId, groupId],
      );

      // open link (email null), capped at 2 uses
      const [linkRow] = await sql.unsafe(
        `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8) as id`,
        [spaceId, null, false, [groupId], inviterId, "inv.open", null, 2],
      );
      expect(linkRow?.id).toBeTruthy();

      const u1 = await mkUser("u1@example.com");
      const u2 = await mkUser("u2@example.com");
      const u3 = await mkUser("u3@example.com");

      // multi-use: two distinct users join with the right token (email ignored)
      expect(await redeem("inv.open", u1, "u1@example.com")).toHaveLength(1);
      expect(await redeem("inv.open", u2, "u2@example.com")).toHaveLength(1);
      // wrong token → nothing
      expect(await redeem("inv.WRONG", u3, "u3@example.com")).toHaveLength(0);
      // third distinct user exceeds max_uses
      expect(await redeem("inv.open", u3, "u3@example.com")).toHaveLength(0);

      // still listed (admin view) with uses=2 + the raw token (re-copyable), but
      // marked invalid — it's exhausted
      const listed = await sql.unsafe(
        `select * from ${s}.list_space_invitations($1)`,
        [spaceId],
      );
      const link = listed.find((r) => r.kind === "link");
      expect(link?.max_uses).toBe(2);
      expect(link?.uses).toBe(2);
      expect(link?.valid).toBe(false);
      expect(link?.token).toBe("inv.open");

      // email-constrained link: only the matching email may redeem, single-use
      const target = "target@example.com";
      await sql.unsafe(
        `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8)`,
        [spaceId, target, false, [groupId], inviterId, "inv.email", null, null],
      );
      const eUser = await mkUser(target);
      expect(
        await redeem("inv.email", eUser, "wrong@example.com"),
      ).toHaveLength(0);
      // a NULL caller email must NOT satisfy an email-constrained invite
      expect(await redeem("inv.email", eUser, null)).toHaveLength(0);
      expect(await redeem("inv.email", eUser, target)).toHaveLength(1);
      expect(await redeem("inv.email", eUser, target)).toHaveLength(0); // consumed

      // revoke_invitation_by_id: a fresh link is dead after revoke
      const [rev] = await sql.unsafe(
        `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8) as id`,
        [spaceId, null, false, [groupId], inviterId, "inv.rev", null, null],
      );
      const revId = rev?.id as string;
      const [ok1] = await sql.unsafe(
        `select ${s}.revoke_invitation_by_id($1, $2) as ok`,
        [spaceId, revId],
      );
      expect(ok1?.ok).toBe(true);
      const rUser = await mkUser("r@example.com");
      expect(await redeem("inv.rev", rUser, "r@example.com")).toHaveLength(0);
      // re-revoke is a no-op
      const [ok2] = await sql.unsafe(
        `select ${s}.revoke_invitation_by_id($1, $2) as ok`,
        [spaceId, revId],
      );
      expect(ok2?.ok).toBe(false);

      // expiry is enforced uniformly (the shared _invitation_valid gate):
      // an already-expired open link can't be redeemed.
      await sql.unsafe(
        `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8)`,
        [
          spaceId,
          null,
          false,
          [groupId],
          inviterId,
          "inv.exp",
          new Date(Date.now() - 60_000).toISOString(),
          null,
        ],
      );
      const xUser = await mkUser("x@example.com");
      expect(await redeem("inv.exp", xUser, "x@example.com")).toHaveLength(0);

      // ... and an expired *email* invite is neither listed for the invitee nor
      // acceptable (the bug this gate closes).
      const expiredEmail = "expired-invitee@example.com";
      const [eInv] = await sql.unsafe(
        `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8) as id`,
        [
          spaceId,
          expiredEmail,
          false,
          [groupId],
          inviterId,
          "inv.eml_exp",
          new Date(Date.now() - 60_000).toISOString(),
          null,
        ],
      );
      const eUser2 = await mkUser(expiredEmail);
      expect(
        await sql.unsafe(
          `select * from ${s}.list_pending_invitations_for_email($1)`,
          [expiredEmail],
        ),
      ).toHaveLength(0);
      expect(
        await sql.unsafe(
          `select * from ${s}.accept_space_invitation($1, $2, $3)`,
          [eUser2, expiredEmail, eInv?.id as string],
        ),
      ).toHaveLength(0);

      // re-membership is a no-op: an existing admin/owner member who redeems a
      // lower (non-admin) invite keeps their role + share — not demoted, not
      // added to the invite's group, not aborted by enforce_last_admin.
      const member = await mkUser("member@example.com");
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        member,
        true, // admin
      ]);
      await sql.unsafe(
        `select ${s}.grant_tree_access($1, $2, 'share'::ltree, $3)`,
        [spaceId, member, 3], // owner@share
      );
      await sql.unsafe(
        `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8)`,
        [spaceId, null, false, [groupId], inviterId, "inv.rejoin", null, null],
      );
      expect(await redeem("inv.rejoin", member, null)).toHaveLength(1); // succeeds
      const [ps] = await sql.unsafe(
        `select admin from ${s}.principal_space where space_id=$1 and principal_id=$2`,
        [spaceId, member],
      );
      expect(ps?.admin).toBe(true); // still admin (not demoted)
      const [taRow] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [member, spaceId],
      );
      expect(taRow?.ta as Grant[]).toContainEqual({
        tree_path: "share",
        access: 3, // still owner@share (not downgraded to read)
      });
    });
  });

  test("invite groups[]: union of grants, coherence trigger, deletion resilience", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Groups",
      ]);
      const spaceId = sp?.id as string;
      const inviterId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        inviterId,
        "inviter@example.com",
      ]);
      const mkGroup = async (name: string, path: string, access: number) => {
        const [g] = await sql.unsafe(
          `select ${s}.create_group($1, $2, false) as id`,
          [spaceId, name],
        );
        const id = g?.id as string;
        await sql.unsafe(
          `select ${s}.grant_tree_access($1, $2, $3::ltree, $4)`,
          [spaceId, id, path, access],
        );
        return id;
      };
      const alpha = await mkGroup("alpha", "share", 2); // write@share
      const beta = await mkGroup("beta", "share.docs", 1); // read@share.docs
      const redeem = (token: string, uid: string) =>
        sql.unsafe(`select * from ${s}.redeem_invitation($1, $2, $3)`, [
          token,
          uid,
          null,
        ]);

      // coherence trigger: a group from another space can't be a target
      const [other] = await sql.unsafe(
        `select ${s}.create_space($1, $2) as id`,
        [randomSlug(), "Other"],
      );
      const [foreign] = await sql.unsafe(
        `select ${s}.create_group($1, $2, false) as id`,
        [other?.id as string, "foreign"],
      );
      await expectReject(() =>
        sql.unsafe(
          `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8)`,
          [
            spaceId,
            null,
            false,
            [alpha, foreign?.id as string],
            inviterId,
            "inv.bad",
            null,
            null,
          ],
        ),
      );

      // an open link to BOTH in-space groups
      await sql.unsafe(
        `select ${s}.create_space_invitation($1,$2,$3,$4::uuid[],$5,$6,$7,$8)`,
        [
          spaceId,
          null,
          false,
          [alpha, beta],
          inviterId,
          "inv.multi",
          null,
          null,
        ],
      );

      // redeem → member of both, inherits the UNION of their grants
      const u1 = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        u1,
        "u1@example.com",
      ]);
      expect(await redeem("inv.multi", u1)).toHaveLength(1);
      const [ta1] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [u1, spaceId],
      );
      expect(ta1?.ta as Grant[]).toContainEqual({
        tree_path: "share",
        access: 2,
      });
      expect(ta1?.ta as Grant[]).toContainEqual({
        tree_path: "share.docs",
        access: 1,
      });

      // deletion resilience: drop beta, a NEW redeemer joins only the survivor
      expect(
        (await sql.unsafe(`select ${s}.delete_principal($1) as ok`, [beta]))[0]
          ?.ok,
      ).toBe(true);
      const u2 = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [
        u2,
        "u2@example.com",
      ]);
      expect(await redeem("inv.multi", u2)).toHaveLength(1);
      const [ta2] = await sql.unsafe(
        `select ${s}.build_tree_access($1, $2) as ta`,
        [u2, spaceId],
      );
      expect(ta2?.ta as Grant[]).toContainEqual({
        tree_path: "share",
        access: 2,
      });
      expect(
        (ta2?.ta as Grant[]).some((g) => g.tree_path === "share.docs"),
      ).toBe(false);
    });
  });

  test("create_api_key + validate_api_key (good, wrong-secret, expired)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, "dave"]);

      const lookup = "abcdEFGH12345678"; // 16 chars, matches lookup_id check
      await sql.unsafe(`select ${s}.create_api_key($1, $2, $3, $4)`, [
        userId,
        lookup,
        "hashed-secret",
        "default",
      ]);

      const valid = await sql.unsafe(
        `select member_id, owner_id from ${s}.validate_api_key($1, $2)`,
        [lookup, "hashed-secret"],
      );
      expect(valid.length).toBe(1);
      expect(valid[0]?.member_id).toBe(userId);
      // a user key has no owner
      expect(valid[0]?.owner_id).toBeNull();

      // an agent key reports the agent's owner (drives `~` home nesting)
      const agentId = await v7();
      await sql.unsafe(`select ${s}.create_agent($1, $2, $3)`, [
        userId, // owner
        `agent_${randomSlug()}`,
        agentId,
      ]);
      const agentLookup = "AGENTlookup12345";
      await sql.unsafe(`select ${s}.create_api_key($1, $2, $3, $4)`, [
        agentId,
        agentLookup,
        "agent-secret",
        "agent-key",
      ]);
      const agentValid = await sql.unsafe(
        `select member_id, owner_id from ${s}.validate_api_key($1, $2)`,
        [agentLookup, "agent-secret"],
      );
      expect(agentValid[0]?.member_id).toBe(agentId);
      expect(agentValid[0]?.owner_id).toBe(userId);

      const wrong = await sql.unsafe(
        `select member_id from ${s}.validate_api_key($1, $2)`,
        [lookup, "nope"],
      );
      expect(wrong.length).toBe(0);

      // expired key
      const lookup2 = "ZYXW9876_-abcdef";
      await sql.unsafe(
        `select ${s}.create_api_key($1, $2, $3, $4, $5::timestamptz)`,
        [userId, lookup2, "h2", "expired", "2000-01-01T00:00:00Z"],
      );
      const expired = await sql.unsafe(
        `select member_id from ${s}.validate_api_key($1, $2)`,
        [lookup2, "h2"],
      );
      expect(expired.length).toBe(0);
    });
  });

  // The enforce_last_admin triggers are DEFERRABLE INITIALLY DEFERRED, so the
  // invariant is judged once at commit against the transaction's final state —
  // not per statement. A single txn can therefore pass through an intermediate
  // "zero admins" state (e.g. demote the incumbent, then promote a replacement)
  // that an immediate trigger would have rejected mid-flight.
  test("deferred last-admin check tolerates an admin swap within one transaction", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Swap",
      ]);
      const spaceId = sp?.id as string;
      const u1 = await v7();
      const u2 = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [u1, "frank"]);
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [u2, "grace"]);
      // u1 is the sole admin; u2 is a non-admin member
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        u1,
        true,
      ]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        u2,
        false,
      ]);

      // Demote the sole admin FIRST, then promote the replacement — the
      // intermediate zero-admin state would trip an immediate trigger.
      await sql.begin(async (tx) => {
        await tx.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
          spaceId,
          u1,
          false,
        ]);
        await tx.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
          spaceId,
          u2,
          true,
        ]);
      });

      const admins = await sql.unsafe(
        `select principal_id from ${s}.principal_space where space_id = $1 and admin order by principal_id`,
        [spaceId],
      );
      expect(admins.map((r) => r.principal_id)).toEqual([u2]);
    });
  });

  test("deferred last-admin check still rejects dropping to zero admins (ME001 at commit)", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const [sp] = await sql.unsafe(`select ${s}.create_space($1, $2) as id`, [
        randomSlug(),
        "Zero",
      ]);
      const spaceId = sp?.id as string;
      const u1 = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [u1, "heidi"]);
      await sql.unsafe(`select ${s}.add_principal_to_space($1, $2, $3)`, [
        spaceId,
        u1,
        true,
      ]);

      // Removing the sole admin: deferred to commit, where the trigger fires and
      // rolls the whole transaction back with the last-admin SQLSTATE (ME001).
      let code: string | undefined;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`select ${s}.remove_principal_from_space($1, $2)`, [
            spaceId,
            u1,
          ]);
        });
        throw new Error("expected a last-admin (ME001) rejection at commit");
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("ME001");

      // rolled back: u1 is still an admin member
      const [row] = await sql.unsafe(
        `select admin from ${s}.principal_space where space_id = $1 and principal_id = $2`,
        [spaceId, u1],
      );
      expect(row?.admin).toBe(true);
    });
  });
});

describe("migration behavior", () => {
  test("is idempotent: re-running changes no migration rows or version", async () => {
    await withTestCore(sql, {}, async (core) => {
      const before = await appliedMigrations(sql, core.schema);
      await migrateCore(sql, { schema: core.schema });
      expect(await appliedMigrations(sql, core.schema)).toEqual(before);
      expect(await getSchemaVersion(sql, core.schema)).toBe(
        CORE_SCHEMA_VERSION,
      );
    });
  });

  // The enforce_last_admin triggers can't use CREATE OR REPLACE / IF NOT EXISTS
  // (constraint triggers support neither), so the idempotent script guards each:
  // (re)create only when the live trigger isn't already a deferred constraint
  // trigger. Exercise both guard branches against real migration output.
  test("guarded constraint triggers: deferred shape, upgrade-from-plain, then skip without churn", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const shape = async (table: string, name: string) =>
        (
          await sql.unsafe(
            `select t.oid::text as oid
                  , t.tgconstraint <> 0 as is_constraint
                  , t.tgdeferrable
                  , t.tginitdeferred
             from pg_trigger t
             where t.tgrelid = '${s}.${table}'::regclass
             and t.tgname = $1
             and not t.tgisinternal`,
            [name],
          )
        )[0];
      const triggers: [string, string][] = [
        ["principal_space", "principal_space_keep_admin_del"],
        ["principal_space", "principal_space_keep_admin_upd"],
        ["principal_space", "principal_space_group_space_coherence"],
        ["group_member", "group_member_keep_admin_del"],
      ];

      // fresh provision: all three are constraint + deferrable + initially deferred
      for (const [table, name] of triggers) {
        const sh = await shape(table, name);
        expect(sh?.is_constraint).toBe(true);
        expect(sh?.tgdeferrable).toBe(true);
        expect(sh?.tginitdeferred).toBe(true);
      }

      // simulate a legacy database: replace one with a PLAIN (non-constraint) trigger
      await sql.unsafe(
        `drop trigger principal_space_keep_admin_del on ${s}.principal_space`,
      );
      await sql.unsafe(
        `create trigger principal_space_keep_admin_del
         after delete on ${s}.principal_space
         for each row when (old.admin)
         execute function ${s}.enforce_last_admin()`,
      );
      expect(
        (await shape("principal_space", "principal_space_keep_admin_del"))
          ?.is_constraint,
      ).toBe(false);

      // re-migrate: the guard sees the wrong shape and upgrades it back
      await migrateCore(sql, { schema: s });
      const upgraded = await shape(
        "principal_space",
        "principal_space_keep_admin_del",
      );
      expect(upgraded?.is_constraint).toBe(true);
      expect(upgraded?.tgdeferrable).toBe(true);
      expect(upgraded?.tginitdeferred).toBe(true);

      // re-migrate again: already the wanted shape, so the guard skips — the
      // trigger is NOT dropped/recreated (its oid is stable across the run).
      await migrateCore(sql, { schema: s });
      const after = await shape(
        "principal_space",
        "principal_space_keep_admin_del",
      );
      expect(after?.oid).toBe(upgraded?.oid);
    });
  });

  // list_space_principals dropped its `direct` output column, a returns-table
  // signature change create-or-replace can't do. The migration guards the drop
  // so a current (or absent) definition is never churned — only a stale one is
  // dropped + recreated.
  test("list_space_principals signature guard: no churn when current, upgrades a stale definition", async () => {
    await withTestCore(sql, {}, async (core) => {
      const s = core.schema;
      const fn = async () => {
        const [row] = await sql.unsafe(
          `select p.oid::text as oid, p.proargnames
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and p.proname = 'list_space_principals'`,
          [s],
        );
        return row as { oid: string; proargnames: string[] } | undefined;
      };

      // fresh provision: current signature (no `direct` output column)
      const fresh = await fn();
      expect(fresh?.proargnames).not.toContain("direct");

      // re-migrate: already current, so the guard must NOT drop it — the oid is
      // stable (create-or-replace refreshes the body in place).
      await migrateCore(sql, { schema: s });
      expect((await fn())?.oid).toBe(fresh?.oid);

      // simulate a legacy DB: replace it with the OLD signature (with `direct`)
      await sql.unsafe(`drop function ${s}.list_space_principals(uuid, text)`);
      await sql.unsafe(
        `create function ${s}.list_space_principals(_space_id uuid, _kind text default null)
         returns table(id uuid, kind text, name text, owner_id uuid, direct bool, admin bool, created_at timestamptz, updated_at timestamptz)
         as $fn$ select null::uuid, null::text, null::text, null::uuid, true, true, null::timestamptz, null::timestamptz where false $fn$
         language sql stable`,
      );
      expect((await fn())?.proargnames).toContain("direct");

      // re-migrate: the guard sees the stale signature and drops + recreates it
      await migrateCore(sql, { schema: s });
      expect((await fn())?.proargnames).not.toContain("direct");
    });
  });

  test("rejects a downgrade (db version newer than app)", async () => {
    await withTestCore(sql, {}, async (core) => {
      await sql.unsafe(`update ${core.schema}.version set version = '99.0.0'`);
      await expect(migrateCore(sql, { schema: core.schema })).rejects.toThrow(
        /older than database version/,
      );
    });
  });

  test("rejects invalid schema names", async () => {
    for (const schema of ["Bad-Schema", "1core", "core test", "core;drop"]) {
      await expect(migrateCore(sql, { schema })).rejects.toThrow(
        /Invalid core schema name/,
      );
    }
  });

  test("concurrent migrateCore on one schema is serialized safely", async () => {
    // The advisory lock serializes writers. A loser may exhaust its retry
    // budget and throw "Unable to acquire lock" — expected, not corruption.
    // What must hold: at least one succeeds and the schema stays valid.
    const schema = randomCoreSchema();
    try {
      const results = await Promise.allSettled([
        migrateCore(sql, { schema }),
        migrateCore(sql, { schema }),
        migrateCore(sql, { schema }),
      ]);

      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(String((r.reason as Error)?.message ?? r.reason)).toContain(
            "Unable to acquire lock",
          );
        }
      }

      expect(await getSchemaVersion(sql, schema)).toBe(CORE_SCHEMA_VERSION);
      expect(await tableExists(sql, schema, "principal")).toBe(true);
    } finally {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    }
  });
});
