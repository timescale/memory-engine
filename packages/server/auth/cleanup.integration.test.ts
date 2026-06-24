// Integration test for the periodic auth cleanup (cleanupExpiredAuth) — the
// cron's only remaining auth dependency after AuthStore was retired. Migrates a
// throwaway auth schema, seeds expired + fresh rows in sessions / verifications /
// oauth_access_token / oauth_refresh_token, and asserts the sweep deletes the
// expired rows (returning per-category counts) while the fresh ones survive.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres" \
//     bun test --timeout 30000 \
//     packages/server/auth/cleanup.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrateAuth } from "@memory.build/database";
import postgres, { type Sql } from "postgres";
import { cleanupExpiredAuth } from "./cleanup";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const rand = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += a[b % 36];
  return s;
};

let sql: Sql;
let schema: string;
let userId: string;

async function count(table: string): Promise<number> {
  const [r] = await sql.unsafe(
    `select count(*)::int as n from ${schema}.${table}`,
  );
  return (r?.n as number) ?? 0;
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  schema = `auth_test_${rand()}`;
  await migrateAuth(sql, { schema }); // also seeds the me-cli oauth_client
  const [u] = await sql.unsafe(
    `insert into ${schema}.users (id, name, email, email_verified)
     values (uuidv7(), 'Cleanup', $1, true) returning id`,
    [`cleanup_${rand()}@example.com`],
  );
  userId = u?.id as string;
});

afterAll(async () => {
  if (schema) await sql.unsafe(`drop schema if exists ${schema} cascade`);
  await sql.end();
});

test("sweeps expired sessions / verifications / oauth tokens, keeps fresh", async () => {
  // One expired + one fresh row in each swept table.
  await sql.unsafe(
    `insert into ${schema}.sessions (user_id, token, expires_at) values
       ($1, 'sess-expired', now() - interval '1 hour'),
       ($1, 'sess-fresh',   now() + interval '1 hour')`,
    [userId],
  );
  await sql.unsafe(
    `insert into ${schema}.verifications (identifier, value, expires_at) values
       ('ver-expired', 'x', now() - interval '1 hour'),
       ('ver-fresh',   'x', now() + interval '1 hour')`,
  );
  await sql.unsafe(
    `insert into ${schema}.oauth_access_token (token, client_id, user_id, scopes, expires_at) values
       ('at-expired', 'me-cli', $1, '[]'::jsonb, now() - interval '1 hour'),
       ('at-fresh',   'me-cli', $1, '[]'::jsonb, now() + interval '1 hour')`,
    [userId],
  );
  await sql.unsafe(
    `insert into ${schema}.oauth_refresh_token (token, client_id, user_id, scopes, expires_at) values
       ('rt-expired', 'me-cli', $1, '[]'::jsonb, now() - interval '1 hour'),
       ('rt-fresh',   'me-cli', $1, '[]'::jsonb, now() + interval '1 hour')`,
    [userId],
  );

  const counts = await cleanupExpiredAuth(sql, schema);

  expect(counts.sessions).toBe(1);
  expect(counts.verifications).toBe(1);
  expect(counts.oauthTokens).toBe(2); // 1 access + 1 refresh

  // Fresh rows survive.
  expect(await count("sessions")).toBe(1);
  expect(await count("verifications")).toBe(1);
  expect(await count("oauth_access_token")).toBe(1);
  expect(await count("oauth_refresh_token")).toBe(1);
});

test("is a no-op when nothing is expired", async () => {
  const counts = await cleanupExpiredAuth(sql, schema);
  expect(counts).toEqual({ sessions: 0, verifications: 0, oauthTokens: 0 });
});
