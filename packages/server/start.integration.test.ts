// Integration test for the extracted startServer() bootstrap.
//
// Boots the real server stack (pools → migrate → worker → Bun.serve) against
// isolated auth/core test schemas on a port-0 listener, then hits /health and
// /ready. No real embeddings are exercised (a placeholder key suffices — the
// worker idles), so this needs no OpenAI key.
//   TEST_DATABASE_URL="$(ghost connect testing_me)" \
//     bun test --timeout 30000 packages/server/start.integration.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import type { EmbeddingConfig } from "@memory.build/embedding";
import postgres, { type Sql } from "postgres";
import { startServer } from "./lib";
import { provisionUser } from "./provision";

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

const embeddingConfig: EmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
  apiKey: "test-key-not-used",
  options: {},
};

let sql: Sql;
let srv: Awaited<ReturnType<typeof startServer>>;
let authSchema: string;
let coreSchema: string;
let spaceSchema: string;
let tamperedDef: string;
let bootedDef: string;
let prevSchemaPrefix: string | undefined;

/** Current definition of a space schema's create_memory function. */
async function createMemoryDef(schema: string): Promise<string> {
  const [row] = await sql`
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema} and p.proname = 'create_memory'`;
  return (row?.def as string) ?? "";
}

beforeAll(async () => {
  // Space schemas created by this suite land under metest_<slug> (not
  // production me_<slug>) so leftovers are reclaimable by name. Scoped to
  // this suite and restored in afterAll: CI runs every integration file in
  // ONE bun process (`find … | xargs bun test`), so a module-scope
  // assignment would leak the prefix into suites that expect me_<slug>.
  prevSchemaPrefix = process.env.SPACE_SCHEMA_PREFIX;
  process.env.SPACE_SCHEMA_PREFIX = "metest_";

  authSchema = `auth_test_${rand()}`;
  coreSchema = `core_test_${rand()}`;
  sql = postgres(URL, { onnotice: () => {} });

  // Simulate an existing deployment: a fully provisioned space whose
  // create_memory predates the current idempotent SQL. Migrate the control
  // plane, provision a user (+ its default space), then tamper the space's
  // create_memory so we can prove boot re-applies the real definition.
  await bootstrapSpaceDatabase(sql);
  await migrateCore(sql, { schema: coreSchema });
  await migrateAuth(sql, { schema: authSchema });
  const provisioned = await provisionUser(
    sql,
    { auth: authSchema, core: coreSchema },
    {
      email: "boot@example.test",
      name: "Boot",
      provider: "github",
      accountId: `boot-${rand()}`,
      emailVerified: true,
    },
  );
  spaceSchema = `metest_${provisioned.spaceSlug}`;
  await sql.unsafe(`
    create or replace function ${spaceSchema}.create_memory
    ( _tree_access jsonb
    , _tree ltree
    , _content text
    , _id uuid default null
    , _meta jsonb default '{}'
    , _temporal tstzrange default null
    )
    returns uuid
    as $func$
    begin
      return null; -- stale stand-in, must be replaced by the boot sweep
    end;
    $func$ language plpgsql volatile
  `);
  tamperedDef = await createMemoryDef(spaceSchema);

  srv = await startServer({
    port: 0,
    databaseUrl: URL,
    apiBaseUrl: "http://localhost",
    authSchema,
    coreSchema,
    embeddingConfig,
    workerCount: 1,
    workerIdleDelayMs: 250,
    workerRefreshIntervalMs: 500,
    enableCleanupCron: false,
    rpcDbTimeoutsMs: {
      statementTimeoutMs: 12_345,
      lockTimeoutMs: 5_432,
      transactionTimeoutMs: 23_456,
      idleInTransactionSessionTimeoutMs: 34_567,
    },
    // migrate defaults to true — startServer migrates the isolated schemas
    // and re-migrates the pre-existing space.
  });
  bootedDef = await createMemoryDef(spaceSchema);
});

afterAll(async () => {
  await srv?.stop();
  await sql.unsafe(`drop schema if exists ${spaceSchema} cascade`);
  await sql.unsafe(`drop schema if exists ${authSchema} cascade`);
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
  if (prevSchemaPrefix === undefined) {
    delete process.env.SPACE_SCHEMA_PREFIX;
  } else {
    process.env.SPACE_SCHEMA_PREFIX = prevSchemaPrefix;
  }
});

test("boots on a random port and serves /health", async () => {
  expect(srv.port).toBeGreaterThan(0);
  const res = await fetch(`${srv.url}/health`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("/ready reports the database is reachable", async () => {
  const res = await fetch(`${srv.url}/ready`);
  expect(res.status).toBe(200);
});

test("runtime pool sets application name and timeout GUCs", async () => {
  const [row] = await srv.context.db`
    select
      current_setting('application_name') as application_name
    , (extract(epoch from current_setting('statement_timeout')::interval) * 1000)::int as statement_timeout_ms
    , (extract(epoch from current_setting('lock_timeout')::interval) * 1000)::int as lock_timeout_ms
    , (extract(epoch from current_setting('transaction_timeout')::interval) * 1000)::int as transaction_timeout_ms
    , (extract(epoch from current_setting('idle_in_transaction_session_timeout')::interval) * 1000)::int as idle_timeout_ms
  `;

  expect(row?.application_name).toBe("me-api");
  expect(Number(row?.statement_timeout_ms)).toBe(12_345);
  expect(Number(row?.lock_timeout_ms)).toBe(5_432);
  expect(Number(row?.transaction_timeout_ms)).toBe(23_456);
  expect(Number(row?.idle_timeout_ms)).toBe(34_567);
});

test("migrated the configured isolated schemas", async () => {
  const [authRow] = await sql`
    select exists (
      select 1 from information_schema.schemata where schema_name = ${authSchema}
    ) as e`;
  const [coreRow] = await sql`
    select exists (
      select 1 from information_schema.schemata where schema_name = ${coreSchema}
    ) as e`;
  expect(Boolean(authRow?.e)).toBe(true);
  expect(Boolean(coreRow?.e)).toBe(true);
});

test("re-migrates existing space schemas on boot", async () => {
  // The tampered function was in place just before boot…
  expect(tamperedDef).toContain("stale stand-in");
  expect(tamperedDef).not.toContain("on conflict");
  // …and boot's space sweep re-applied the idempotent SQL over it
  // (create_memory is the one-row wrapper delegating to batch_create_memory).
  expect(bootedDef).not.toContain("stale stand-in");
  expect(bootedDef).toContain("batch_create_memory");
});
