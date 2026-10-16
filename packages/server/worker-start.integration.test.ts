// Local-only integration coverage for independent API and embedding lifecycles.
// TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
//   ./bun test --timeout 30000 packages/server/worker-start.integration.test.ts
import { expect, test } from "bun:test";
import {
  bootstrapSpaceDatabase,
  generateSlug,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import type { EmbeddingConfig } from "@memory.build/embedding";
import { coreStore, formatApiKey } from "@memory.build/engine/core";
import postgres, { type Sql } from "postgres";
import { type RunningServer, startServer } from "./lib";
import { seedUserSpace } from "./test-support";
import { startEmbeddingWorkers } from "./worker-start";

// Follow the suite's TEST_DATABASE_URL contract, never application DB settings.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

type Workers = Awaited<ReturnType<typeof startEmbeddingWorkers>>;

async function eventually(label: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** The only embedding provider used by this suite: a loopback OpenAI stub. */
function embeddingProvider() {
  const inputs: string[] = [];
  const paths: string[] = [];
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      paths.push(new URL(request.url).pathname);
      const body = (await request.json()) as { input: string | string[] };
      const batch = Array.isArray(body.input) ? body.input : [body.input];
      inputs.push(...batch);
      await gate;
      return Response.json({
        object: "list",
        data: batch.map((_, index) => ({
          object: "embedding",
          index,
          // Exactly representable in halfvec; check the actual stored vector.
          embedding: Array.from({ length: 1536 }, () => 0.25),
        })),
        model: "text-embedding-3-small",
        usage: { prompt_tokens: batch.length, total_tokens: batch.length },
      });
    },
  });
  const config: EmbeddingConfig = {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    apiKey: "local-stub-only",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    options: { maxRetries: 0, timeoutMs: 10_000 },
  };
  return {
    config,
    inputs,
    paths,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      gate = undefined;
    },
    stop() {
      release?.();
      server.stop(true);
    },
  };
}

/** Own every resource before setup, so even a failed migration/seed is cleaned. */
async function withFixture(
  run: (fixture: {
    sql: Sql;
    coreSchema: string;
    authSchema: string;
    spaceSchema: string;
    spaceSlug: string;
    token: string;
    provider: ReturnType<typeof embeddingProvider>;
    bootApi: (workerCount: number) => Promise<RunningServer>;
    bootWorkers: () => Promise<Workers>;
    extraSchemas: string[];
  }) => Promise<void>,
) {
  const savedEnv = {
    SPACE_SCHEMA_PREFIX: process.env.SPACE_SCHEMA_PREFIX,
    API_BASE_URL: process.env.API_BASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  };
  process.env.SPACE_SCHEMA_PREFIX = "metest_";
  delete process.env.API_BASE_URL;
  delete process.env.BETTER_AUTH_SECRET;
  const coreSchema = `core_test_${generateSlug()}`;
  const authSchema = `auth_test_${generateSlug()}`;
  const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  let providerForCleanup: ReturnType<typeof embeddingProvider> | undefined;
  const handles: Array<{ stop(): Promise<void> }> = [];
  const extraSchemas: string[] = [];
  const errors: unknown[] = [];
  try {
    const provider = embeddingProvider();
    providerForCleanup = provider;
    await bootstrapSpaceDatabase(sql);
    await migrateCore(sql, { schema: coreSchema });
    const core = coreStore(sql, coreSchema);
    // Core-only seed and PAT avoid exercising OAuth or social login.
    const seeded = await seedUserSpace(sql, { core: coreSchema });
    const spaceSchema = `metest_${seeded.spaceSlug}`;
    const key = await core.createApiKey(seeded.userId, "worker-integration");
    await run({
      sql,
      coreSchema,
      authSchema,
      spaceSchema,
      spaceSlug: seeded.spaceSlug,
      token: formatApiKey(key.lookupId, key.secret),
      provider,
      extraSchemas,
      async bootApi(workerCount) {
        await migrateAuth(sql, { schema: authSchema });
        const server = await startServer({
          port: 0,
          databaseUrl: DATABASE_URL,
          workerDatabaseUrl: DATABASE_URL,
          authSchema,
          coreSchema,
          apiBaseUrl: "http://127.0.0.1",
          betterAuthSecret: "local-worker-test-secret-0123456789",
          embeddingConfig: provider.config,
          workerCount,
          workerIdleDelayMs: 25,
          workerRefreshIntervalMs: 50,
          migrate: false,
          enableCleanupCron: false,
        });
        handles.push(server);
        return server;
      },
      async bootWorkers() {
        // Intentionally no auth schema, signing secret, or public API URL.
        const workers = await startEmbeddingWorkers({
          databaseUrl: DATABASE_URL,
          workerDatabaseUrl: DATABASE_URL,
          coreSchema,
          embeddingConfig: provider.config,
          workerCount: 1,
          workerIdleDelayMs: 25,
          workerRefreshIntervalMs: 50,
        });
        handles.push(workers);
        return workers;
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    // Release held HTTP requests before stopping workers (including on failure).
    providerForCleanup?.release();
    const attempt = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const handle of handles.reverse()) {
      await attempt(() => handle.stop());
    }
    await attempt(async () => providerForCleanup?.stop());
    // Also find a space registered by a seed that failed before returning.
    await attempt(async () => {
      const spaces = await coreStore(sql, coreSchema).listSpaces();
      extraSchemas.push(...spaces.map((space) => `metest_${space.slug}`));
    });
    for (const schema of new Set([...extraSchemas, authSchema, coreSchema])) {
      if (!/^(core_test_|auth_test_|metest_)[a-z0-9]+$/.test(schema)) {
        errors.push(new Error(`Refusing to drop non-test schema ${schema}`));
        continue;
      }
      await attempt(() =>
        sql.unsafe(`drop schema if exists ${schema} cascade`),
      );
    }
    await attempt(() => sql.end({ timeout: 5 }));
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Test or fixture cleanup failed");
  }
}

async function createViaApi(
  server: RunningServer,
  spaceSlug: string,
  token: string,
  content: string,
): Promise<string> {
  const response = await fetch(`${server.url}/api/v1/memory/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Me-Space": spaceSlug,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "memory.create",
      params: { content, tree: "/share/worker-test" },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result?: { id: string };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  expect(body.result?.id).toBeString();
  return body.result?.id as string;
}

async function queueState(sql: Sql, schema: string, id: string) {
  const [row] = await sql.unsafe(
    `select q.outcome, q.attempts, m.embedding::text as embedding
     from ${schema}.embedding_queue q
     join ${schema}.memory m on m.id = q.memory_id
     where m.id = $1`,
    [id],
  );
  return row;
}

async function expectEmbedded(sql: Sql, schema: string, id: string) {
  await eventually("completed queue entry and vector write-back", async () => {
    const row = await queueState(sql, schema, id);
    return row?.outcome === "completed" && row.embedding !== null;
  });
  const row = await queueState(sql, schema, id);
  expect(row?.attempts).toBe(1);
  expect(JSON.parse(row?.embedding as string)).toEqual(
    Array.from({ length: 1536 }, () => 0.25),
  );
}

test("API-only writes stay pending until a standalone runner starts; shutdown is idempotent", async () => {
  await withFixture(async (f) => {
    const api = await f.bootApi(0);
    expect((await fetch(`${api.url}/health`)).status).toBe(200);
    expect((await fetch(`${api.url}/ready`)).status).toBe(200);
    const content = "API-only memory waiting for the separate embedding runner";
    const id = await createViaApi(api, f.spaceSlug, f.token, content);
    // Several poll intervals pass: API-only mode must not claim the queue.
    await Bun.sleep(250);
    const pending = await queueState(f.sql, f.spaceSchema, id);
    expect(pending?.outcome).toBeNull();
    expect(pending?.embedding).toBeNull();
    expect(pending?.attempts).toBe(0);
    expect(f.provider.inputs).toEqual([]);

    // Shutdown must wait for the actual provider call AND vector write-back,
    // not just for a mocked queue transaction to finish.
    f.provider.hold();
    const workers = await f.bootWorkers();
    await eventually(
      "held embedding request",
      async () => f.provider.inputs.length === 1,
    );
    let stopped = false;
    const stopping = workers.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    expect((await queueState(f.sql, f.spaceSchema, id))?.embedding).toBeNull();
    f.provider.release();
    await Promise.all([stopping, workers.stop()]);
    await expectEmbedded(f.sql, f.spaceSchema, id);
    expect(workers.stats.totalProcessed).toBe(1);
    expect(workers.stats.totalFailed).toBe(0);
    expect(f.provider.inputs).toEqual([content]);
    expect(f.provider.paths).toEqual(["/v1/embeddings"]);
    await workers.stop();

    // Stopping the runner neither stops the API nor leaves consumers running.
    const next = await createViaApi(
      api,
      f.spaceSlug,
      f.token,
      "after runner stop",
    );
    await Bun.sleep(150);
    expect((await queueState(f.sql, f.spaceSchema, next))?.attempts).toBe(0);
    expect(f.provider.inputs).toEqual([content]);
    expect((await fetch(`${api.url}/ready`)).status).toBe(200);
    await Promise.all([api.stop(), api.stop()]);
    await api.stop();
  });
}, 30_000);

test("independent runners cooperate without auth or migrations and survive a peer stopping", async () => {
  await withFixture(async (f) => {
    // pg_proc row versions change on CREATE OR REPLACE, even when the SQL body
    // is identical. A worker must consume current schemas, never re-migrate.
    const definitions = () => f.sql`
      select p.oid, p.xmin::text as version from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in (${f.coreSchema}, ${f.spaceSchema}) order by p.oid`;
    const before = await definitions();
    const insert = async (content: string) => {
      const [row] = await f.sql.unsafe(
        `insert into ${f.spaceSchema}.memory (content, tree)
         values ($1, 'share'::ltree) returning id`,
        [content],
      );
      return row?.id as string;
    };

    f.provider.hold();
    const firstId = await insert("runner A holds this claim");
    const first = await f.bootWorkers();
    await eventually(
      "first runner's held request",
      async () => f.provider.inputs.length === 1,
    );
    const secondId = await insert("runner B must claim independently");
    const second = await f.bootWorkers();
    // A is blocked in HTTP, so only B can claim the second memory. This avoids
    // assuming scheduler fairness or depending on a particular batch size.
    await eventually(
      "second runner's held request",
      async () => f.provider.inputs.length === 2,
    );
    f.provider.release();
    await expectEmbedded(f.sql, f.spaceSchema, firstId);
    await expectEmbedded(f.sql, f.spaceSchema, secondId);
    await eventually(
      "both runners reporting success",
      async () =>
        first.stats.totalProcessed === 1 && second.stats.totalProcessed === 1,
    );
    expect(first.stats.totalFailed + second.stats.totalFailed).toBe(0);
    expect(f.provider.inputs).toEqual([
      "runner A holds this claim",
      "runner B must claim independently",
    ]);
    expect(await definitions()).toEqual(before);
    const [auth] =
      await f.sql`select to_regnamespace(${f.authSchema}) as schema`;
    expect(auth?.schema).toBeNull();

    await Promise.all([first.stop(), first.stop()]);
    const thirdId = await insert("surviving runner processes new work");
    await expectEmbedded(f.sql, f.spaceSchema, thirdId);
    await eventually(
      "surviving runner success stats",
      async () => second.stats.totalProcessed === 2,
    );
    expect(first.stats.totalProcessed).toBe(1);
    expect(f.provider.inputs).toHaveLength(3);
  });
}, 30_000);

test("combined API and embedding mode still drains API writes", async () => {
  await withFixture(async (f) => {
    const api = await f.bootApi(1);
    const id = await createViaApi(
      api,
      f.spaceSlug,
      f.token,
      "combined mode memory",
    );
    await expectEmbedded(f.sql, f.spaceSchema, id);
    expect(f.provider.inputs).toEqual(["combined mode memory"]);
  });
}, 30_000);

test("discovery lock timeout bounds startup and releases pools for a later retry", async () => {
  await withFixture(async (f) => {
    const saved = process.env.WORKER_DB_LOCK_TIMEOUT;
    process.env.WORKER_DB_LOCK_TIMEOUT = "75ms";
    try {
      await f.sql.begin(async (tx) => {
        await tx.unsafe(
          `lock table ${f.coreSchema}.space in access exclusive mode`,
        );
        await expect(f.bootWorkers()).rejects.toThrow("lock timeout");
      });
      const healthy = await f.bootWorkers();
      await healthy.stop();
    } finally {
      if (saved === undefined) delete process.env.WORKER_DB_LOCK_TIMEOUT;
      else process.env.WORKER_DB_LOCK_TIMEOUT = saved;
    }
  });
}, 30_000);

test("missing, uninitialized, and malformed core schemas reject before returning a runner", async () => {
  await withFixture(async (f) => {
    const missing = `core_test_${generateSlug()}`;
    const empty = `core_test_${generateSlug()}`;
    f.extraSchemas.push(missing, empty);
    await f.sql.unsafe(`create schema ${empty}`);
    for (const coreSchema of [missing, empty, `${missing}-invalid`]) {
      // Capture an unexpectedly returned handle so a failed assertion still
      // stops it; a rejects assertion alone would leak such a runner.
      let unexpected: Workers | undefined;
      try {
        await expect(
          (async () => {
            unexpected = await startEmbeddingWorkers({
              databaseUrl: DATABASE_URL,
              workerDatabaseUrl: DATABASE_URL,
              coreSchema,
              embeddingConfig: f.provider.config,
              workerCount: 1,
              workerIdleDelayMs: 25,
              workerRefreshIntervalMs: 50,
            });
          })(),
        ).rejects.toThrow();
      } finally {
        await unexpected?.stop();
      }
    }
    const [absent] = await f.sql`select to_regnamespace(${missing}) as schema`;
    expect(absent?.schema).toBeNull();
    const [objects] = await f.sql`
      select count(*)::int as count from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${empty}`;
    expect(objects?.count).toBe(0);
    expect(f.provider.inputs).toEqual([]);
    // Failed startup must not poison later startup against a valid schema.
    const healthy = await f.bootWorkers();
    await Promise.all([healthy.stop(), healthy.stop()]);
  });
}, 30_000);
