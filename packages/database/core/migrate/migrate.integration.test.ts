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
import { CORE_SCHEMA_VERSION } from "../version";
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
];

const EXPECTED_FUNCTIONS = [
  "agent_tree_access",
  "is_principal_in_space",
  "is_principal_space_admin",
  "member_groups",
  "member_tree_access",
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
  test("principal.kind is restricted to g/u/a", async () => {
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
});

describe("control-plane functions", () => {
  /** A fresh uuidv7 from the database (principal.id requires version 7). */
  async function v7(): Promise<string> {
    const [row] = await sql.unsafe(`select uuidv7() as id`);
    return row?.id as string;
  }

  /** A principal's canonical home path (mirrors space/path.ts homePrefix). */
  const homePath = (id: string) => `home.${id.replace(/-/g, "")}`;

  type Grant = { tree_path: string; access: number };

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

  test("add_principal_to_space grants owner@home to users, idempotently; not agents/groups", async () => {
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

      // add each twice to prove the home grant is idempotent
      for (const id of [userId, agentId, groupId]) {
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
      // agents are excluded (would be clamped to the owner) and groups have no home
      expect(await grants(agentId)).toEqual([]);
      expect(await grants(groupId)).toEqual([]);
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

  test("space invitations: create (upsert) / list / redeem (join + home + share) / revoke", async () => {
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
      const create = (admin: boolean, share: number | null) =>
        sql.unsafe(
          `select ${s}.create_space_invitation($1, $2, $3, $4, $5) as id`,
          [spaceId, email, admin, share, inviterId],
        );

      // create (read share, not admin), then re-create promotes the SAME pending
      // row to admin + owner share (upsert, not a duplicate)
      const [c1] = await create(false, 1);
      const inviteId = c1?.id as string;
      expect(inviteId).toBeTruthy();
      const [c2] = await create(true, 3);
      expect(c2?.id).toBe(inviteId);

      // list: one pending invite with the updated fields + the inviter's name
      const listed = await sql.unsafe(
        `select * from ${s}.list_space_invitations($1)`,
        [spaceId],
      );
      expect(listed).toHaveLength(1);
      expect(listed[0]?.email).toBe(email);
      expect(listed[0]?.admin).toBe(true);
      expect(listed[0]?.share_access).toBe(3);
      expect(listed[0]?.invited_by_name).toBe("inviter@example.com");

      // the invitee registers, then redeems (email match is case-insensitive)
      const userId = await v7();
      await sql.unsafe(`select ${s}.create_user($1, $2)`, [userId, email]);
      const redeemed = await sql.unsafe(
        `select * from ${s}.redeem_space_invitations($1, $2)`,
        [userId, "INVITEE@EXAMPLE.COM"],
      );
      expect(redeemed).toHaveLength(1);
      expect(redeemed[0]?.space_id).toBe(spaceId);
      expect(redeemed[0]?.admin).toBe(true);
      expect(redeemed[0]?.share_access).toBe(3);

      // joined as admin, with owner@home (add_principal_to_space) + owner@share
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

      // accepted: gone from the pending list, and re-redeem is a no-op
      expect(
        await sql.unsafe(`select * from ${s}.list_space_invitations($1)`, [
          spaceId,
        ]),
      ).toHaveLength(0);
      expect(
        await sql.unsafe(
          `select * from ${s}.redeem_space_invitations($1, $2)`,
          [userId, email],
        ),
      ).toHaveLength(0);

      // revoke: a fresh pending invite is revocable once
      await create(false, null); // re-invite the same email (now allowed: prior is accepted)
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
        `select member_id from ${s}.validate_api_key($1, $2)`,
        [lookup, "hashed-secret"],
      );
      expect(valid.length).toBe(1);
      expect(valid[0]?.member_id).toBe(userId);

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
