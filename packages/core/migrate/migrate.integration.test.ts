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
