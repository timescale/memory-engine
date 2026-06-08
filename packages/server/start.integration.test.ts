// Integration test for the extracted startServer() bootstrap.
//
// Boots the real server stack (pools → migrate → worker → Bun.serve) against
// isolated auth/core test schemas on a port-0 listener, then hits /health and
// /ready. No real embeddings are exercised (a placeholder key suffices — the
// worker idles with no spaces), so this needs no OpenAI key.
//   TEST_DATABASE_URL="$(ghost connect testing_me)" \
//     bun test --timeout 30000 packages/server/start.integration.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { EmbeddingConfig } from "@memory.build/embedding";
import postgres, { type Sql } from "postgres";
import { startServer } from "./lib";

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

beforeAll(async () => {
  authSchema = `auth_test_${rand()}`;
  coreSchema = `core_test_${rand()}`;
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
    // migrate defaults to true — startServer migrates the isolated schemas.
  });
  sql = postgres(URL, { onnotice: () => {} });
});

afterAll(async () => {
  await srv?.stop();
  await sql.unsafe(`drop schema if exists ${authSchema} cascade`);
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
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
