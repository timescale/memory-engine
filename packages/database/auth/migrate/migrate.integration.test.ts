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
  listColumns,
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
  "jwks",
  "migration",
  "oauth_access_token",
  "oauth_client",
  "oauth_consent",
  "oauth_refresh_token",
  "sessions",
  "users",
  "verifications",
  "version",
];

// Exact column set for every better-auth / oauth-provider-owned table. These
// names are dictated by the library's adapter (and the @better-auth/oauth-provider
// plugin) — drift breaks at runtime (a missing/renamed field the adapter reads),
// invisibly to the table-name check above. Freezing the full set turns any
// unmigrated change red and forces the design/AUTH_DESIGN "Upgrading better-auth"
// checklist to be run. Listed in definition order; the assertion sorts both sides.
// (The `migration` + `version` tables are our own infra, not better-auth's, so
// they're intentionally excluded.)
const EXPECTED_COLUMNS: Record<string, string[]> = {
  users: [
    "id",
    "name",
    "email",
    "email_verified",
    "image",
    "created_at",
    "updated_at",
  ],
  accounts: [
    "id",
    "user_id",
    "provider_id",
    "account_id",
    "access_token",
    "refresh_token",
    "id_token",
    "access_token_expires_at",
    "refresh_token_expires_at",
    "scope",
    "password",
    "created_at",
    "updated_at",
  ],
  // 006 dropped token_hash and added token + updated_at (better-auth's session shape).
  sessions: [
    "id",
    "user_id",
    "token",
    "expires_at",
    "ip_address",
    "user_agent",
    "created_at",
    "updated_at",
  ],
  verifications: [
    "id",
    "identifier",
    "value",
    "expires_at",
    "created_at",
    "updated_at",
  ],
  jwks: ["id", "public_key", "private_key", "created_at", "expires_at"],
  oauth_client: [
    "id",
    "client_id",
    "client_secret",
    "disabled",
    "skip_consent",
    "enable_end_session",
    "subject_type",
    "scopes",
    "user_id",
    "created_at",
    "updated_at",
    "name",
    "uri",
    "icon",
    "contacts",
    "tos",
    "policy",
    "software_id",
    "software_version",
    "software_statement",
    "redirect_uris",
    "post_logout_redirect_uris",
    "token_endpoint_auth_method",
    "grant_types",
    "response_types",
    "public",
    "type",
    "require_pkce",
    "reference_id",
    "metadata",
  ],
  oauth_refresh_token: [
    "id",
    "token",
    "client_id",
    "session_id",
    "user_id",
    "reference_id",
    "expires_at",
    "created_at",
    "revoked",
    "auth_time",
    "scopes",
  ],
  oauth_access_token: [
    "id",
    "token",
    "client_id",
    "session_id",
    "user_id",
    "reference_id",
    "refresh_id",
    "expires_at",
    "created_at",
    "scopes",
  ],
  oauth_consent: [
    "id",
    "client_id",
    "user_id",
    "reference_id",
    "scopes",
    "created_at",
    "updated_at",
  ],
};

// 004_device_authorization stays in the log (it ran historically); 006 dropped
// its tables/functions and added the better-auth OAuth-provider + jwks schema.
const EXPECTED_MIGRATIONS = [
  "001_users",
  "002_accounts",
  "003_sessions",
  "004_device_authorization",
  "005_verifications",
  "006_betterauth",
];

// The functions the schema still owns after 006: the updated_at trigger fn, the
// user/account helpers, and the cron cleanup sweeps. (Session validation + the
// device flow moved to better-auth / were dropped.)
const EXPECTED_FUNCTIONS = [
  "update_updated_at",
  "create_user",
  "get_user",
  "get_user_by_email",
  "upsert_account",
  "get_account_by_provider",
  "cleanup_expired_sessions",
  "cleanup_expired_verifications",
  "cleanup_expired_oauth_tokens",
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

  // Drift guard: every better-auth / oauth-provider-owned table must have exactly
  // the column set the library expects. A library upgrade (or hand-edit) that
  // changes the shape without a migration fails here instead of silently at
  // runtime. Exact match (not subset) so an *added* unmigrated column is caught too.
  test.each(
    Object.entries(EXPECTED_COLUMNS),
  )("%s has exactly the better-auth column set (drift guard)", async (table, expected) => {
    const actual = await listColumns(sql, canonical.schema, table);
    expect(actual).toEqual([...expected].sort());
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

  test("creates the expected SQL functions in the schema", async () => {
    const functions = await listFunctions(sql, canonical.schema);
    for (const fn of EXPECTED_FUNCTIONS) {
      expect(functions).toContain(fn);
    }
  });

  test("installs updated_at triggers on trigger-managed tables only", async () => {
    for (const table of ["users", "accounts", "verifications"]) {
      const triggers = await listTriggers(sql, canonical.schema, table);
      expect(triggers).toContain(`${table}_before_update_trg`);
    }
    // sessions has an updated_at column but better-auth maintains it (no DB
    // trigger), so the before-update trigger must not be installed there.
    const sessionTriggers = await listTriggers(
      sql,
      canonical.schema,
      "sessions",
    );
    expect(sessionTriggers).not.toContain("sessions_before_update_trg");
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

  test("session token is unique (better-auth's plaintext lookup token)", async () => {
    const s = canonical.schema;
    const userId = await insertUser(sql, s);
    const token = `tok_${crypto.randomUUID()}`;
    await sql.unsafe(
      `insert into ${s}.sessions (user_id, token, expires_at)
       values ('${userId}', '${token}', now() + interval '1 day')`,
    );
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.sessions (user_id, token, expires_at)
         values ('${userId}', '${token}', now() + interval '1 day')`,
      ),
    );
  });

  test("the me-cli OAuth client is seeded (public PKCE client, consent skipped)", async () => {
    const [cli] = await sql.unsafe(
      `select public, type, require_pkce, skip_consent
         from ${canonical.schema}.oauth_client where client_id = 'me-cli'`,
    );
    expect(cli).toBeDefined();
    expect(cli?.public).toBe(true);
    expect(cli?.type).toBe("native");
    expect(cli?.require_pkce).toBe(true);
    expect(cli?.skip_consent).toBe(true);
  });

  test("oauth_access_token.token is unique and client_id FKs oauth_client", async () => {
    const s = canonical.schema;
    const userId = await insertUser(sql, s);
    await sql.unsafe(
      `insert into ${s}.oauth_access_token (token, client_id, user_id, scopes, expires_at)
       values ('at-dup', 'me-cli', '${userId}', '[]'::jsonb, now() + interval '1 hour')`,
    );
    // duplicate token → unique violation
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.oauth_access_token (token, client_id, user_id, scopes, expires_at)
         values ('at-dup', 'me-cli', '${userId}', '[]'::jsonb, now() + interval '1 hour')`,
      ),
    );
    // unknown client_id → FK violation
    await expectReject(() =>
      sql.unsafe(
        `insert into ${s}.oauth_access_token (token, client_id, user_id, scopes, expires_at)
         values ('at-orphan', 'no-such-client', '${userId}', '[]'::jsonb, now() + interval '1 hour')`,
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
        `insert into ${s}.sessions (user_id, token, expires_at) values ('${userId}', 'tok_${crypto.randomUUID()}', now() + interval '1 day')`,
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
