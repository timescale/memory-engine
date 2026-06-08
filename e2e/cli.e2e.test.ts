// End-to-end CLI integration test.
//
//   me (spawned binary) ──HTTP──▶ server (real Bun.serve) ──▶ postgres.js ──▶ ghost test DB
//
// Drives the real `me` CLI as a subprocess against a real in-process server
// (startServer) and the ghost test database, with real OpenAI embeddings. No
// mocks between the CLI and the database. See PLAN_E2E_TESTING.md.
//
//   TEST_DATABASE_URL="$(ghost connect testing_me)" ./bun run test:e2e
//
// Boundaries (deliberate): authentication is token injection (provisionUser +
// createSession → ME_SESSION_TOKEN), not `me login`; embeddings hit real OpenAI
// directly (a key is required to run — the suite skips, not fails, without one).

// Set the space-schema prefix before anything reads it. slugToSchema reads
// SPACE_SCHEMA_PREFIX lazily (per call), so this only needs to run before the
// first call at runtime (in beforeAll) — well after import hoisting. Spaces
// land under metest_<slug> so the existing reclaimer sweeps them.
process.env.SPACE_SCHEMA_PREFIX = "metest_";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStore } from "@memory.build/auth";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { Sql } from "postgres";
import {
  connect,
  resolveTestDatabaseUrl,
} from "../packages/database/migrate/test-utils.ts";
import { type RunningServer, startServer } from "../packages/server/lib.ts";
import { provisionUser } from "../packages/server/provision.ts";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? process.env.EMBEDDING_API_KEY;

const repoRoot = join(import.meta.dir, "..");
const CLI = join(repoRoot, "packages/cli/index.ts");

const rand = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += a[b % 36];
  return s;
};

let sql: Sql; // harness's own connection (setup/teardown/assert)
let srv: RunningServer;
let authSchema: string;
let coreSchema: string;
let spaceSlug: string;
let token: string;
let tmpHome: string;

describe.skipIf(!OPENAI_KEY || !process.env.TEST_DATABASE_URL)(
  "cli e2e",
  () => {
    beforeAll(async () => {
      sql = connect();
      authSchema = `auth_test_${rand()}`;
      coreSchema = `core_test_${rand()}`;
      await bootstrapSpaceDatabase(sql);
      await migrateAuth(sql, { schema: authSchema });
      await migrateCore(sql, { schema: coreSchema });

      // Provision the user (and its default space) BEFORE booting the server, so
      // the worker discovers the space at startup — no rediscovery lag for the
      // initial space.
      const provisioned = await provisionUser(
        sql,
        { auth: authSchema, core: coreSchema },
        {
          email: "e2e@example.test",
          name: "E2E",
          provider: "github",
          accountId: `e2e-${rand()}`,
          emailVerified: true,
        },
      );
      spaceSlug = provisioned.spaceSlug;
      ({ token } = await authStore(sql, authSchema).createSession(
        provisioned.userId,
      ));

      const embeddingConfig: EmbeddingConfig = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        // OPENAI_KEY is non-null here (describe.skipIf guards it).
        apiKey: OPENAI_KEY as string,
        options: {},
      };

      srv = await startServer({
        port: 0,
        databaseUrl: resolveTestDatabaseUrl(),
        apiBaseUrl: "http://localhost", // OAuth callbacks unused (token injection)
        authSchema,
        coreSchema,
        migrate: false, // harness already migrated
        enableCleanupCron: false,
        workerCount: 1,
        workerIdleDelayMs: 250, // poll the embed queue fast
        workerRefreshIntervalMs: 500, // discover new spaces fast
        embeddingConfig,
      });

      tmpHome = await mkdtemp(join(tmpdir(), "me-e2e-"));
    });

    afterAll(async () => {
      await srv?.stop();
      // Drop the space schemas this run created (enumerating core.space covers
      // CLI-created spaces too), then the auth/core test schemas.
      if (sql && coreSchema) {
        const spaces = await sql.unsafe(`select slug from ${coreSchema}.space`);
        for (const row of spaces) {
          await sql.unsafe(`drop schema if exists metest_${row.slug} cascade`);
        }
        await sql.unsafe(`drop schema if exists ${authSchema} cascade`);
        await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
        await sql.end();
      }
      if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
    });

    // -------------------------------------------------------------------------
    // CLI subprocess helpers
    // -------------------------------------------------------------------------

    function cliEnv(
      extra: Record<string, string> = {},
    ): Record<string, string> {
      const env = { ...process.env } as Record<string, string>;
      // Curate: drop any ambient ME_* so the dev's shell can't leak in.
      for (const k of [
        "ME_API_KEY",
        "ME_SERVER",
        "ME_SPACE",
        "ME_SESSION_TOKEN",
      ]) {
        delete env[k];
      }
      return {
        ...env,
        HOME: tmpHome,
        XDG_CONFIG_HOME: join(tmpHome, ".config"),
        ME_NO_KEYCHAIN: "1",
        ME_SERVER: srv.url,
        ME_SESSION_TOKEN: token,
        ME_SPACE: spaceSlug,
        ...extra,
      };
    }

    async function me(
      args: string[],
      extraEnv?: Record<string, string>,
    ): Promise<{ stdout: string; stderr: string; code: number }> {
      const proc = Bun.spawn([process.execPath, CLI, ...args], {
        env: cliEnv(extraEnv),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { stdout, stderr, code };
    }

    // Parse the --json stdout of a `me` invocation, asserting success.
    async function meJson<T = unknown>(
      args: string[],
      extraEnv?: Record<string, string>,
    ): Promise<T> {
      const r = await me([...args, "--json"], extraEnv);
      expect(
        r.code,
        `expected exit 0 for \`me ${args.join(" ")}\`\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      ).toBe(0);
      return JSON.parse(r.stdout) as T;
    }

    // Poll the space schema until N memories have a non-null embedding.
    async function waitForEmbeddings(count: number, timeoutMs = 30000) {
      const schema = `metest_${spaceSlug}`;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [row] = await sql.unsafe(
          `select count(*)::int as n from ${schema}.memory where embedding is not null`,
        );
        if ((row?.n ?? 0) >= count) return;
        await Bun.sleep(250);
      }
      throw new Error(`timed out waiting for ${count} embeddings`);
    }

    // -------------------------------------------------------------------------
    // Core scenarios
    // -------------------------------------------------------------------------

    test("1. whoami reports the provisioned identity", async () => {
      const r = await me(["whoami"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("e2e@example.test");
    });

    test("2. create + tree round-trip (default share namespace)", async () => {
      const created = await meJson<{ id: string; tree?: string }>([
        "create",
        "the quick brown fox jumps over the lazy dog",
      ]);
      expect(created.id).toBeTruthy();

      const r = await me(["memory", "tree"]);
      expect(r.code).toBe(0);
      expect(r.stdout.toLowerCase()).toContain("share");
    });

    test("3. fulltext (BM25) search finds the memory", async () => {
      const res = await meJson<{
        total: number;
        results: { id: string; content: string }[];
      }>(["search", "--fulltext", "fox"]);
      expect(res.total).toBeGreaterThan(0);
      expect(
        res.results.some((m) => m.content.includes("quick brown fox")),
      ).toBe(true);
    });

    test("4. semantic search ranks a paraphrase near the top", async () => {
      // Seed a few more memories to make ranking meaningful.
      await meJson(["create", "a dog chased a cat across the yard"]);
      await meJson(["create", "the stock market fell sharply on Tuesday"]);
      await meJson(["create", "photosynthesis converts sunlight into energy"]);

      // 4 created so far in `share` (1 from scenario 2 + 3 here). Wait for the
      // worker to embed them.
      await waitForEmbeddings(4);

      const res = await meJson<{
        results: { id: string; content: string }[];
      }>(["search", "--semantic", "wild canine leaps over a sleepy hound"]);
      // Recall-based: the fox/dog memories should surface near the top, not the
      // stock-market or photosynthesis ones. Assert a relevant item is in top-3.
      const top3 = res.results.slice(0, 3).map((m) => m.content);
      expect(top3.some((c) => c.includes("fox") || c.includes("dog"))).toBe(
        true,
      );
    });

    test("5. tree paths reflect ~ (home) and share conventions", async () => {
      await meJson(["create", "personal note", "--tree", "~/notes"]);
      await meJson(["create", "team note", "--tree", "share/team"]);

      const r = await me(["memory", "tree"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("notes");
      expect(r.stdout).toContain("team");
    });

    test("6. update + delete round-trip", async () => {
      const created = await meJson<{ id: string }>([
        "create",
        "ephemeral memory to edit",
      ]);
      const updated = await meJson<{ id: string; content: string }>([
        "memory",
        "update",
        created.id,
        "--content",
        "edited content",
      ]);
      expect(updated.content).toBe("edited content");

      const del = await me(["memory", "delete", created.id, "--yes"]);
      expect(del.code).toBe(0);

      // Getting it now fails with a non-zero exit.
      const get = await me(["memory", "get", created.id]);
      expect(get.code).not.toBe(0);
    });

    // -------------------------------------------------------------------------
    // Extended scenarios
    // -------------------------------------------------------------------------

    test("7. api-key auth works end-to-end (no session token)", async () => {
      // Mint the key through the real CLI: create the agent, add it to the
      // space, then mint a key for it.
      const agent = await meJson<{ id: string }>([
        "agent",
        "create",
        `bot-${rand()}`,
      ]);
      await me(["agent", "add", agent.id]); // bring the agent into the space
      // Agents join with no grant (their access is clamped to the owner's), so
      // grant read on `share` — where the fox memory lives — to make it readable.
      await meJson(["access", "grant", agent.id, "share", "r"]);
      const key = await meJson<{ id: string; key: string }>([
        "apikey",
        "create",
        agent.id,
      ]);
      expect(key.key).toMatch(/^me\./);

      // Search with ONLY the api key — no session token. The agent's global key
      // plus X-Me-Space (ME_SPACE) selects the space; this exercises the CLI's
      // api-key auth path against the real server end-to-end.
      const res = await meJson<{ total: number }>(
        ["search", "--fulltext", "fox"],
        { ME_API_KEY: key.key, ME_SESSION_TOKEN: "" },
      );
      expect(res.total).toBeGreaterThan(0);
    });

    test("10. failure modes: bad space and missing auth exit non-zero", async () => {
      const badSpace = await me(["search", "--fulltext", "fox"], {
        ME_SPACE: "doesnotexist1",
      });
      expect(badSpace.code).not.toBe(0);

      const noAuth = await me(["whoami"], { ME_SESSION_TOKEN: "" });
      expect(noAuth.code).not.toBe(0);
    });
  },
);
