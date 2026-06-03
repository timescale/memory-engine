// Integration tests for the `auth` schema migrations (migrateAuth).
//
// The auth migrations are templated, so each test targets its own throwaway
// `auth_test_<rand>` schema — never the real `auth`. That makes these tests
// isolated and safe to run against any database (including a shared dev one).
// Read-only shape assertions share one canonical auth schema provisioned in
// beforeAll; the few behavior tests provision their own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql as SQL } from "postgres";
import { AUTH_SCHEMA_VERSION } from "../version";
import { migrateAuth } from "./migrate";
import {
  appliedMigrations,
  connect,
  expectReject,
  extensionInstalled,
  getSchemaVersion,
  listFunctions,
  listTables,
  listTriggers,
  randomAuthSchema,
  schemaExists,
  TestAuth,
  tableExists,
  withTestAuth,
} from "./test-utils";

const EXPECTED_TABLES = [
  "accounts",
  "device_authorization",
  "migration",
  "sessions",
  "users",
  "verifications",
  "version",
];

const EXPECTED_MIGRATIONS = [
  "001_users",
  "002_accounts",
  "003_sessions",
  "004_device_authorization",
  "005_verifications",
];

const EXPECTED_FUNCTIONS = [
  "update_updated_at",
  "create_user",
  "get_user",
  "get_user_by_email",
  "create_session",
  "validate_session",
  "upsert_account",
  "get_account_by_provider",
  "create_device_auth",
  "authorize_device",
  "poll_device",
];

// The auth schema deliberately requires only citext — not the engine extensions.
const REQUIRED_EXTENSIONS = ["citext"];

const V7 = "00000000-0000-7000-8000-000000000000";
const V4 = "00000000-0000-4000-8000-000000000000";

/** Insert a user and return its id (most tables FK to users). */
async function insertUser(sql: SQL, schema: string): Promise<string> {
  const email = `u_${crypto.randomUUID().slice(0, 8)}@example.com`;
  const [row] = await sql.unsafe(
    `insert into ${schema}.users (name, email) values ('Test', '${email}') returning id`,
  );
  return row?.id as string;
}

let sql: SQL;
// One migrated auth schema shared by all read-only shape/function assertions.
let canonical: TestAuth;

beforeAll(async () => {
  sql = connect(12);
  canonical = await TestAuth.create(sql); // migrateAuth installs citext itself
});

afterAll(async () => {
  await canonical?.drop();
  await sql.end();
});

describe("provisioned auth schema", () => {
  test("provisions into the requested (templated) schema", async () => {
    expect(canonical.schema).toMatch(/^auth_test_/);
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
      AUTH_SCHEMA_VERSION,
    );
  });

  test("installs only the required extensions", async () => {
    for (const ext of REQUIRED_EXTENSIONS) {
      expect(await extensionInstalled(sql, ext)).toBe(true);
    }
  });

  test("creates the updated_at trigger function in the schema", async () => {
    const functions = await listFunctions(sql, canonical.schema);
    for (const fn of EXPECTED_FUNCTIONS) {
      expect(functions).toContain(fn);
    }
  });

  test("installs updated_at triggers on mutable tables only", async () => {
    for (const table of ["users", "accounts", "verifications"]) {
      const triggers = await listTriggers(sql, canonical.schema, table);
      expect(triggers).toContain(`${table}_before_update_trg`);
    }
    // insert/delete-only tables have no updated_at and thus no trigger
    for (const table of ["sessions", "device_authorization"]) {
      const triggers = await listTriggers(sql, canonical.schema, table);
      expect(triggers).not.toContain(`${table}_before_update_trg`);
    }
  });
});

describe("schema constraints enforce", () => {
  test("user ids must be UUIDv7", async () => {
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.users (id, name, email)
         values ('${V4}', 'v4', 'v4@example.com')`,
      ),
    );
  });

  test("user email is unique and case-insensitive (citext)", async () => {
    const s = canonical.schema;
    const email = `Dup_${crypto.randomUUID().slice(0, 8)}@Example.com`;
    await sql.unsafe(
      `insert into ${s}.users (name, email) values ('a', '${email}')`,
    );
    try {
      await expectReject(() =>
        sql.unsafe(
          `insert into ${s}.users (name, email) values ('b', '${email.toLowerCase()}')`,
        ),
      );
    } finally {
      await sql.unsafe(`delete from ${s}.users where email = '${email}'`);
    }
  });

  test("accounts.provider_id is restricted to google/github", async () => {
    const userId = await insertUser(sql, canonical.schema);
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.accounts (user_id, provider_id, account_id)
         values ('${userId}', 'facebook', 'x')`,
      ),
    );
  });

  test("accounts are unique per (provider_id, account_id)", async () => {
    const s = canonical.schema;
    const userId = await insertUser(sql, s);
    const acct = crypto.randomUUID();
    await sql.unsafe(
      `insert into ${s}.accounts (user_id, provider_id, account_id)
       values ('${userId}', 'github', '${acct}')`,
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.accounts (user_id, provider_id, account_id)
         values ('${userId}', 'github', '${acct}')`,
      ),
    );
  });

  test("accounts.user_id must reference an existing user", async () => {
    await expectReject(() =>
      sql.unsafe(
        `insert into ${canonical.schema}.accounts (user_id, provider_id, account_id)
         values ('${V7}', 'github', 'orphan')`,
      ),
    );
  });

  test("session token_hash is unique", async () => {
    const s = canonical.schema;
    const userId = await insertUser(sql, s);
    await sql.unsafe(
      `insert into ${s}.sessions (user_id, token_hash, expires_at)
       values ('${userId}', '\\xdeadbeef', now() + interval '1 day')`,
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.sessions (user_id, token_hash, expires_at)
         values ('${userId}', '\\xdeadbeef', now() + interval '1 day')`,
      ),
    );
  });

  test("device_authorization.user_code is unique", async () => {
    const s = canonical.schema;
    const code = `AB${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    await sql.unsafe(
      `insert into ${s}.device_authorization (device_code, user_code, provider, oauth_state, expires_at)
       values ('${crypto.randomUUID()}', '${code}', 'google', '${crypto.randomUUID()}', now() + interval '15 min')`,
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.device_authorization (device_code, user_code, provider, oauth_state, expires_at)
         values ('${crypto.randomUUID()}', '${code}', 'google', '${crypto.randomUUID()}', now() + interval '15 min')`,
      ),
    );
  });
});

describe("auth functions", () => {
  const email = () => `fn_${crypto.randomUUID().slice(0, 8)}@example.com`;

  test("create_user + get_user + get_user_by_email (citext)", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      const s = auth.schema;
      const e = email();
      const [u] = await sql.unsafe(
        `select ${s}.create_user($1, $2, $3) as id`,
        [e, "Alice", true],
      );
      const id = u?.id as string;

      const [byId] = await sql.unsafe(`select * from ${s}.get_user($1)`, [id]);
      expect(byId?.id).toBe(id);
      expect(byId?.email).toBe(e);
      expect(byId?.email_verified).toBe(true);

      // citext: lookup is case-insensitive
      const [byEmail] = await sql.unsafe(
        `select * from ${s}.get_user_by_email($1)`,
        [e.toUpperCase()],
      );
      expect(byEmail?.id).toBe(id);
    });
  });

  test("create_session + validate_session (valid + expired)", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      const s = auth.schema;
      const [u] = await sql.unsafe(`select ${s}.create_user($1, $2) as id`, [
        email(),
        "Bob",
      ]);
      const userId = u?.id as string;

      await sql.unsafe(
        `select ${s}.create_session($1, $2::bytea, now() + interval '1 day')`,
        [userId, "\\xabcd"],
      );
      const valid = await sql.unsafe(
        `select * from ${s}.validate_session($1::bytea)`,
        ["\\xabcd"],
      );
      expect(valid.length).toBe(1);
      expect(valid[0]?.user_id).toBe(userId);

      await sql.unsafe(
        `select ${s}.create_session($1, $2::bytea, now() - interval '1 second')`,
        [userId, "\\xbeef"],
      );
      const expired = await sql.unsafe(
        `select * from ${s}.validate_session($1::bytea)`,
        ["\\xbeef"],
      );
      expect(expired.length).toBe(0);
    });
  });

  test("upsert_account + get_account_by_provider (login lookup, idempotent)", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      const s = auth.schema;
      const [u] = await sql.unsafe(`select ${s}.create_user($1, $2) as id`, [
        email(),
        "Carol",
      ]);
      const userId = u?.id as string;
      const acct = crypto.randomUUID();

      await sql.unsafe(`select ${s}.upsert_account($1, 'github', $2)`, [
        userId,
        acct,
      ]);
      const found = await sql.unsafe(
        `select * from ${s}.get_account_by_provider('github', $1)`,
        [acct],
      );
      expect(found[0]?.user_id).toBe(userId);

      // re-upsert the same (provider, account) stays one row
      await sql.unsafe(`select ${s}.upsert_account($1, 'github', $2)`, [
        userId,
        acct,
      ]);
      const [n] = await sql.unsafe(
        `select count(*)::int as n from ${s}.accounts where provider_id='github' and account_id=$1`,
        [acct],
      );
      expect(n?.n).toBe(1);

      const none = await sql.unsafe(
        `select * from ${s}.get_account_by_provider('github', $1)`,
        [crypto.randomUUID()],
      );
      expect(none.length).toBe(0);
    });
  });

  test("device flow: create → lookups → poll_device → authorize", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      const s = auth.schema;
      const [u] = await sql.unsafe(`select ${s}.create_user($1, $2) as id`, [
        email(),
        "Dave",
      ]);
      const userId = u?.id as string;

      const deviceCode = crypto.randomUUID();
      const userCode = "ABCD-2345";
      const oauthState = crypto.randomUUID();
      await sql.unsafe(
        `select ${s}.create_device_auth($1, $2, 'google', $3, now() + interval '15 min')`,
        [deviceCode, userCode, oauthState],
      );

      const byState = await sql.unsafe(
        `select * from ${s}.get_device_by_oauth_state($1)`,
        [oauthState],
      );
      expect(byState[0]?.device_code).toBe(deviceCode);
      const byUserCode = await sql.unsafe(
        `select * from ${s}.get_device_by_user_code($1)`,
        [userCode],
      );
      expect(byUserCode[0]?.device_code).toBe(deviceCode);

      // poll before authorization → pending (interval 0 bypasses rate limit)
      const [p1] = await sql.unsafe(`select * from ${s}.poll_device($1, 0)`, [
        deviceCode,
      ]);
      expect(p1?.status).toBe("pending");
      expect(p1?.user_id).toBeNull();

      // immediate re-poll with the default interval → slow_down
      const [sd] = await sql.unsafe(`select * from ${s}.poll_device($1)`, [
        deviceCode,
      ]);
      expect(sd?.status).toBe("slow_down");

      // authorize binds the user; a second authorize is a no-op
      const [a] = await sql.unsafe(
        `select ${s}.authorize_device($1, $2) as ok`,
        [deviceCode, userId],
      );
      expect(a?.ok).toBe(true);
      const [a2] = await sql.unsafe(
        `select ${s}.authorize_device($1, $2) as ok`,
        [deviceCode, userId],
      );
      expect(a2?.ok).toBe(false);

      // poll now resolves to authorized + the bound user
      const [p2] = await sql.unsafe(`select * from ${s}.poll_device($1, 0)`, [
        deviceCode,
      ]);
      expect(p2?.status).toBe("authorized");
      expect(p2?.user_id).toBe(userId);

      // unknown / expired device code → expired
      const [ex] = await sql.unsafe(`select * from ${s}.poll_device($1, 0)`, [
        crypto.randomUUID(),
      ]);
      expect(ex?.status).toBe("expired");
    });
  });
});

describe("cascade + trigger behavior", () => {
  test("deleting a user cascades to accounts and sessions", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      const s = auth.schema;
      const userId = await insertUser(sql, s);
      await sql.unsafe(
        `insert into ${s}.accounts (user_id, provider_id, account_id) values ('${userId}', 'github', '1')`,
      );
      await sql.unsafe(
        `insert into ${s}.sessions (user_id, token_hash, expires_at) values ('${userId}', '\\xaa', now() + interval '1 day')`,
      );

      await sql.unsafe(`delete from ${s}.users where id = '${userId}'`);

      const [acct] = await sql.unsafe(
        `select count(*)::int as n from ${s}.accounts where user_id = '${userId}'`,
      );
      const [sess] = await sql.unsafe(
        `select count(*)::int as n from ${s}.sessions where user_id = '${userId}'`,
      );
      expect(acct?.n).toBe(0);
      expect(sess?.n).toBe(0);
    });
  });

  test("updating a user bumps updated_at via trigger", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      const s = auth.schema;
      const userId = await insertUser(sql, s);
      const [before] = await sql.unsafe(
        `select updated_at from ${s}.users where id = '${userId}'`,
      );
      expect(before?.updated_at).toBeNull();

      await sql.unsafe(
        `update ${s}.users set name = 'Renamed' where id = '${userId}'`,
      );
      const [after] = await sql.unsafe(
        `select updated_at from ${s}.users where id = '${userId}'`,
      );
      expect(after?.updated_at).not.toBeNull();
    });
  });
});

describe("migration behavior", () => {
  test("is idempotent: re-running changes no migration rows or version", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      const before = await appliedMigrations(sql, auth.schema);
      await migrateAuth(sql, { schema: auth.schema });
      expect(await appliedMigrations(sql, auth.schema)).toEqual(before);
      expect(await getSchemaVersion(sql, auth.schema)).toBe(
        AUTH_SCHEMA_VERSION,
      );
    });
  });

  test("rejects a downgrade (db version newer than app)", async () => {
    await withTestAuth(sql, {}, async (auth) => {
      await sql.unsafe(`update ${auth.schema}.version set version = '99.0.0'`);
      await expect(migrateAuth(sql, { schema: auth.schema })).rejects.toThrow(
        /older than database version/,
      );
    });
  });

  test("rejects invalid schema names", async () => {
    for (const schema of ["Bad-Schema", "1auth", "auth test", "auth;drop"]) {
      await expect(migrateAuth(sql, { schema })).rejects.toThrow(
        /Invalid auth schema name/,
      );
    }
  });

  test("concurrent migrateAuth on one schema is serialized safely", async () => {
    // The advisory lock serializes writers. A loser may exhaust its retry
    // budget and throw "Unable to acquire lock" — expected, not corruption.
    // What must hold: at least one succeeds and the schema stays valid.
    const schema = randomAuthSchema();
    try {
      const results = await Promise.allSettled([
        migrateAuth(sql, { schema }),
        migrateAuth(sql, { schema }),
        migrateAuth(sql, { schema }),
      ]);

      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(String((r.reason as Error)?.message ?? r.reason)).toContain(
            "Unable to acquire lock",
          );
        }
      }

      expect(await getSchemaVersion(sql, schema)).toBe(AUTH_SCHEMA_VERSION);
      expect(await tableExists(sql, schema, "users")).toBe(true);
    } finally {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
    }
  });
});
