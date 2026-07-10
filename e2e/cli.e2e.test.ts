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
// Boundaries (deliberate): authentication is token injection (seedUserSpace +
// a minted OAuth access token → ME_SESSION_TOKEN, the raw-bearer override), not
// `me login`'s browser round-trip; embeddings hit real OpenAI directly (a key is
// required to run — the suite skips, not fails, without one).

// Set the space-schema prefix before anything reads it. slugToSchema reads
// SPACE_SCHEMA_PREFIX lazily (per call), so this only needs to run before the
// first call at runtime (in beforeAll) — well after import hoisting. Spaces
// land under metest_<slug> so the existing reclaimer sweeps them.
process.env.SPACE_SCHEMA_PREFIX = "metest_";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
} from "@memory.build/database";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { Sql } from "postgres";
import { encodeProjectDir } from "../packages/cli/importers/claude.ts";
import {
  connect,
  resolveTestDatabaseUrl,
} from "../packages/database/migrate/test-utils.ts";
import { type RunningServer, startServer } from "../packages/server/lib.ts";
import { seedUserSpace } from "../packages/server/test-support.ts";

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
let spaceId: string;
let token: string;
let tmpHome: string;
// The user's private home parent (`~/projects` normalized): captures and
// session/git imports default here since the private-by-default change.
let homeProjects: string;

// TEST_CI disables the conditional skip: in CI this suite always runs
// (missing env fails loudly as test errors, never as a silent skip).
describe.skipIf(
  !process.env.TEST_CI && (!OPENAI_KEY || !process.env.TEST_DATABASE_URL),
)("cli e2e", () => {
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
    // auth: also insert the better-auth users row — the minted OAuth bearer
    // below joins users in verifyOAuthAccessToken.
    const provisioned = await seedUserSpace(
      sql,
      { core: coreSchema, auth: authSchema },
      { email: "e2e@example.test", name: "E2E" },
    );
    spaceSlug = provisioned.spaceSlug;
    spaceId = provisioned.spaceId;
    homeProjects = `home.${provisioned.userId.replace(/-/g, "")}.projects`;
    // Inject a real OAuth access token as the bearer (ME_SESSION_TOKEN is the
    // raw-bearer override): store sha256(raw) in oauth_access_token — exactly
    // what the server hashes + looks up — and hand the CLI the raw token. Bound
    // to the seeded `me-cli` client; long-lived so a slow ghost run won't expire.
    const rawToken = `me_at_${rand()}${rand()}`;
    await sql.unsafe(
      `insert into ${authSchema}.oauth_access_token
         (token, client_id, user_id, scopes, expires_at)
       values ($1, 'me-cli', $2, '["openid"]'::jsonb, now() + interval '24 hours')`,
      [createHash("sha256").update(rawToken).digest("hex"), provisioned.userId],
    );
    token = rawToken;

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
      // better-auth requires a signing secret to boot; the e2e authenticates by
      // token injection (no sign-in), so any stable test value works.
      betterAuthSecret: "test-better-auth-secret-0123456789",
      migrate: false, // harness already migrated
      enableCleanupCron: false,
      workerCount: 1,
      workerIdleDelayMs: 250, // poll the embed queue fast
      workerRefreshIntervalMs: 500, // discover new spaces fast
      embeddingConfig,
    });

    tmpHome = await mkdtemp(join(tmpdir(), "me-e2e-"));
    // Opt into session capture machine-wide (the `me claude install` prompt
    // would write this) — the capture hook ships inert without it. Also store
    // the default server + active space so tests that must NOT set ME_SPACE
    // (per-project space routing) still resolve the base space like a real
    // logged-in machine would. `agent: .user` is the deliberate "run as the
    // user, no agent identity" escape hatch — capture hooks resolve an agent
    // ambiently now (agent-by-config) and SKIP silently when nothing is in
    // scope at all; without this, every hook-based capture in this suite
    // would silently no-op.
    await mkdir(join(tmpHome, ".config", "me"), { recursive: true });
    await writeFile(
      join(tmpHome, ".config", "me", "config.yaml"),
      `capture: true\nagent: .user\ndefault_server: ${srv.url}\nservers:\n  "${srv.url}":\n    active_space: ${spaceSlug}\n`,
    );
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

  function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env = { ...process.env } as Record<string, string>;
    // Curate: drop any ambient ME_* so the dev's shell can't leak in.
    for (const k of [
      "ME_API_KEY",
      "ME_SERVER",
      "ME_SPACE",
      "ME_SESSION_TOKEN",
      "ME_AS_AGENT",
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
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      env: cliEnv(extraEnv),
      stdout: "pipe",
      stderr: "pipe",
      ...(cwd ? { cwd } : {}),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  }

  // A scratch bin dir with trivial executable stubs for the named binaries —
  // lets a test simulate "harness X is installed" (Bun.which(x) !== null,
  // what `me project init`'s CLAUDE.md/AGENTS.md steps gate on) without
  // depending on what's actually on PATH wherever this suite runs: a dev
  // machine may have the real `claude` CLI; CI has none of these. Prepend the
  // returned dir to PATH via `me(...)`'s extraEnv.
  async function fakeHarnessBins(names: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "me-e2e-fakebin-"));
    for (const name of names) {
      const file = join(dir, name);
      await writeFile(file, "#!/bin/sh\nexit 0\n");
      await chmod(file, 0o755);
    }
    return dir;
  }

  // Like `me`, but pipes `input` to the process's stdin (for `me claude hook`,
  // which reads the event JSON from stdin).
  async function meStdin(
    args: string[],
    input: string,
    extraEnv?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      env: cliEnv(extraEnv),
      stdin: new TextEncoder().encode(input),
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

  // The canonical (leading-slash) display form of a dotted ltree path — what
  // the API/CLI return. Used to assert returned `tree` values against the
  // dotted paths the tests build for input / ltree queries.
  const toSlashPath = (dotted: string): string =>
    `/${dotted.replace(/\./g, "/")}`;

  // Count memories under a tree in this run's space schema.
  async function countUnder(treePrefix: string): Promise<number> {
    const [row] = await sql.unsafe(
      `select count(*)::int as n from metest_${spaceSlug}.memory
         where tree <@ $1::ltree`,
      [treePrefix],
    );
    return (row?.n as number) ?? 0;
  }

  // Count memories captured from a given source session id.
  async function countBySession(sessionId: string): Promise<number> {
    const [row] = await sql.unsafe(
      `select count(*)::int as n from metest_${spaceSlug}.memory
         where meta->>'source_session_id' = $1`,
      [sessionId],
    );
    return (row?.n as number) ?? 0;
  }

  // Parse the --json stdout of a `me` invocation, asserting success.
  async function meJson<T = unknown>(
    args: string[],
    extraEnv?: Record<string, string>,
    cwd?: string,
  ): Promise<T> {
    const r = await me([...args, "--json"], extraEnv, cwd);
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

  // Seed a SECOND, non-admin space member with their own OAuth bearer, so the
  // suite can exercise self-service leave as a plain member (the primary
  // identity is the space's sole admin). Mirrors the beforeAll token injection:
  // insert the auth `users` row (verifyOAuthAccessToken joins it) + a hashed
  // oauth_access_token, and hand back the raw token as env2.
  async function seedSecondMember(): Promise<{
    userId: string;
    email: string;
    env2: Record<string, string>;
  }> {
    const [idRow] = await sql.unsafe(`select uuidv7() as id`);
    const userId = idRow?.id as string;
    const email = `member_${rand()}@example.test`;
    await sql.unsafe(
      `insert into ${authSchema}.users (id, name, email, email_verified)
         values ($1, $2, $3, true)`,
      [userId, "Member", email],
    );
    // core side, via the same SQL functions ensureUserProvisioned composes
    await sql.unsafe(`select ${coreSchema}.create_user($1, $2)`, [
      userId,
      email,
    ]);
    await sql.unsafe(
      `select ${coreSchema}.add_principal_to_space($1, $2, $3)`,
      [spaceId, userId, false], // non-admin member
    );

    const raw = `me_at_${rand()}${rand()}`;
    await sql.unsafe(
      `insert into ${authSchema}.oauth_access_token
         (token, client_id, user_id, scopes, expires_at)
       values ($1, 'me-cli', $2, '["openid"]'::jsonb, now() + interval '24 hours')`,
      [createHash("sha256").update(raw).digest("hex"), userId],
    );
    return { userId, email, env2: { ME_SESSION_TOKEN: raw } };
  }

  // -------------------------------------------------------------------------
  // Core scenarios
  // -------------------------------------------------------------------------

  test("1. whoami reports the provisioned identity", async () => {
    const r = await me(["whoami"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("e2e@example.test");
    // TNT-162: the active space renders as name (slug), with an admin marker
    // (the creator is an admin) and the auth method.
    expect(r.stdout).toContain(`default (${spaceSlug}) [admin]`);
    expect(r.stdout).toContain("Auth:   session");

    // JSON gains a resolved `space` object + `auth`, without dropping the
    // backward-compatible `activeSpace` slug.
    const who = await meJson<{
      activeSpace: string | null;
      space: { slug: string; name: string; admin: boolean } | null;
      auth: string;
    }>(["whoami"]);
    expect(who.activeSpace).toBe(spaceSlug);
    expect(who.space?.slug).toBe(spaceSlug);
    expect(who.space?.name).toBe("default");
    expect(who.space?.admin).toBe(true);
    expect(who.auth).toBe("session");
  });

  test("1b. status reports server, space, and embedding backlog", async () => {
    const r = await me(["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(srv.url);
    expect(r.stdout).toContain(spaceSlug);
    expect(r.stdout).toContain("Embedding queue");

    // JSON carries the server/space plus numeric embedding counts. Assert
    // structure, not exact counts — the embedding worker may drain the queue
    // between the create and this call.
    const status = await meJson<{
      server: string;
      activeSpace: string;
      embedding: {
        pending: number;
        inFlight: number;
        waiting: number;
        failed: number;
        oldestPendingAt: string | null;
      };
    }>(["status"]);
    expect(status.activeSpace).toBe(spaceSlug);
    expect(typeof status.embedding.pending).toBe("number");
    expect(typeof status.embedding.failed).toBe("number");
    expect(status.embedding.pending).toBe(
      status.embedding.inFlight + status.embedding.waiting,
    );
  });

  test("2. create + tree round-trip (share namespace)", async () => {
    const created = await meJson<{ id: string; tree?: string }>([
      "create",
      "the quick brown fox jumps over the lazy dog",
      "--tree",
      "share",
    ]);
    expect(created.id).toBeTruthy();

    const r = await me(["memory", "tree"]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("share");
  });

  test("2b. memory count supports exact and capped tree-filter counts", async () => {
    const branch = `share.countprobe${rand()}`;
    await meJson(["create", "count probe one", "--tree", `${branch}.one`]);
    await meJson(["create", "count probe two", "--tree", `${branch}.two`]);

    const exact = await meJson<{ count: number }>(["memory", "count", branch]);
    expect(exact.count).toBe(2);

    const capped = await meJson<{ count: number }>([
      "memory",
      "count",
      `${branch}.*`,
      "--max-count",
      "1",
    ]);
    expect(capped.count).toBe(1);
  });

  test("2c. memory copy previews and duplicates a subtree", async () => {
    const base = `share.copyprobe${rand()}`;
    const src = `${base}.src`;
    const dst = `${base}.dst`;

    const first = await meJson<{ id: string }>([
      "create",
      "copy probe one",
      "--tree",
      `${src}.one`,
    ]);
    await meJson(["create", "copy probe two", "--tree", `${src}.two`]);
    await meJson(["create", "copy probe keep", "--tree", `${base}.keep`]);

    const dry = await meJson<{ count: number; dryRun?: boolean }>([
      "memory",
      "copy",
      src,
      dst,
      "--dry-run",
    ]);
    expect(dry.count).toBe(2);
    expect(dry.dryRun).toBe(true);
    expect(await countUnder(src)).toBe(2);
    expect(await countUnder(dst)).toBe(0);
    expect(await countUnder(`${base}.keep`)).toBe(1);

    const copied = await meJson<{ count: number }>([
      "memory",
      "copy",
      src,
      dst,
      "--yes",
    ]);
    expect(copied.count).toBe(2);
    expect(await countUnder(src)).toBe(2);
    expect(await countUnder(dst)).toBe(2);
    expect(await countUnder(`${base}.keep`)).toBe(1);

    const fetched = await meJson<{ tree: string }>(["memory", "get", first.id]);
    expect(fetched.tree).toBe(toSlashPath(`${src}.one`));
  });

  test("2d. memory move previews and relocates a subtree", async () => {
    const base = `share.moveprobe${rand()}`;
    const src = `${base}.src`;
    const dst = `${base}.dst`;

    const first = await meJson<{ id: string }>([
      "create",
      "move probe one",
      "--tree",
      `${src}.one`,
    ]);
    await meJson(["create", "move probe two", "--tree", `${src}.two`]);
    await meJson(["create", "move probe keep", "--tree", `${base}.keep`]);

    const dry = await meJson<{ count: number; dryRun?: boolean }>([
      "memory",
      "move",
      src,
      dst,
      "--dry-run",
    ]);
    expect(dry.count).toBe(2);
    expect(dry.dryRun).toBe(true);
    expect(await countUnder(src)).toBe(2);
    expect(await countUnder(dst)).toBe(0);
    expect(await countUnder(`${base}.keep`)).toBe(1);

    const moved = await meJson<{ count: number }>([
      "memory",
      "move",
      src,
      dst,
      "--yes",
    ]);
    expect(moved.count).toBe(2);
    expect(await countUnder(src)).toBe(0);
    expect(await countUnder(dst)).toBe(2);
    expect(await countUnder(`${base}.keep`)).toBe(1);

    const fetched = await meJson<{ tree: string }>(["memory", "get", first.id]);
    expect(fetched.tree).toBe(toSlashPath(`${dst}.one`));
  });

  test("2e. export alias writes matching memories as JSON", async () => {
    const branch = `share.exportprobe${rand()}`;
    await meJson(["create", "export probe one", "--tree", `${branch}.one`]);
    await meJson(["create", "export probe two", "--tree", `${branch}.two`]);

    const exported = await meJson<{ content: string; tree: string }[]>([
      "export",
      "--tree",
      `${branch}.*`,
      "--format",
      "json",
    ]);

    expect(exported.map((m) => m.content).sort()).toEqual([
      "export probe one",
      "export probe two",
    ]);
    expect(exported.map((m) => m.tree).sort()).toEqual([
      toSlashPath(`${branch}.one`),
      toSlashPath(`${branch}.two`),
    ]);
  });

  test("3. fulltext (BM25) search finds the memory", async () => {
    const res = await meJson<{
      total: number;
      results: { id: string; content: string }[];
    }>(["search", "--fulltext", "fox"]);
    expect(res.total).toBeGreaterThan(0);
    expect(res.results.some((m) => m.content.includes("quick brown fox"))).toBe(
      true,
    );
  });

  test("4. semantic search ranks a paraphrase near the top", async () => {
    // Seed a few more memories to make ranking meaningful.
    const seed = (text: string) => meJson(["create", text, "--tree", "share"]);
    await seed("a dog chased a cat across the yard");
    await seed("the stock market fell sharply on Tuesday");
    await seed("photosynthesis converts sunlight into energy");

    // 4 created so far in `share` (1 from scenario 2 + 3 here). Wait for the
    // worker to embed them.
    await waitForEmbeddings(4);

    const res = await meJson<{
      results: { id: string; content: string }[];
    }>(["search", "--semantic", "wild canine leaps over a sleepy hound"]);
    // Recall-based: the fox/dog memories should surface near the top, not the
    // stock-market or photosynthesis ones. Assert a relevant item is in top-3.
    const top3 = res.results.slice(0, 3).map((m) => m.content);
    expect(top3.some((c) => c.includes("fox") || c.includes("dog"))).toBe(true);
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
    const created = await meJson<{ id: string; versionHash: string }>([
      "create",
      "ephemeral memory to edit",
      "--tree",
      "share",
    ]);
    const updated = await meJson<{ id: string; content: string }>([
      "memory",
      "update",
      created.id,
      "--version-hash",
      created.versionHash,
      "--content",
      "edited content",
    ]);
    expect(updated.content).toBe("edited content");

    const del = await me(["memory", "delete", created.id]);
    expect(del.code).toBe(0);

    // Getting it now fails with a non-zero exit.
    const get = await me(["memory", "get", created.id]);
    expect(get.code).not.toBe(0);
  });

  test("6d. append: by id, by path, stdin, dry-run, empty no-op, compact output", async () => {
    // Self-contained: own memory under a unique subtree so no shared-state
    // count assertions are affected; cleaned up at the end.
    const created = await meJson<{ id: string }>([
      "create",
      "first line",
      "--tree",
      "share.append_e2e",
      "--name",
      "log",
    ]);

    // append by id (positional content) — compact JSON result, no body field.
    const app1 = await meJson<{
      id: string;
      version: number;
      appendedBytes: number;
      replayed: boolean;
      content?: string;
    }>(["append", created.id, "second line"]);
    expect(app1.version).toBe(2);
    expect(app1.replayed).toBe(false);
    expect(app1.content).toBeUndefined();

    // append by tree/name path, content via stdin (--content -).
    const app2 = await meStdin(
      ["append", "share/append_e2e/log", "--content", "-", "--json"],
      "third line",
    );
    expect(app2.code).toBe(0);

    const got = await meJson<{ content: string; version: number }>([
      "memory",
      "get",
      created.id,
    ]);
    expect(got.content).toBe("first line\n\nsecond line\n\nthird line");

    // dry-run writes nothing.
    const dry = await meJson<{ dryRun: boolean }>([
      "append",
      created.id,
      "not written",
      "--dry-run",
    ]);
    expect(dry.dryRun).toBe(true);
    expect(
      (await meJson<{ version: number }>(["memory", "get", created.id]))
        .version,
    ).toBe(got.version);

    // empty/whitespace input is a no-op (exit 0, no version bump).
    const noop = await me(["append", created.id, "   "]);
    expect(noop.code).toBe(0);
    expect(
      (await meJson<{ version: number }>(["memory", "get", created.id]))
        .version,
    ).toBe(got.version);

    // text-mode success is compact — never echoes the appended text or body.
    const textOut = await me(["append", created.id, "SENSITIVE-BODY-TEXT"]);
    expect(textOut.code).toBe(0);
    expect(textOut.stdout + textOut.stderr).not.toContain(
      "SENSITIVE-BODY-TEXT",
    );
    expect(textOut.stdout + textOut.stderr).toContain(created.id);

    await me(["memory", "delete", created.id]);
  });

  test("6b. name: create --name, get by path, conflict modes, rename, delete --name", async () => {
    const created = await meJson<{ id: string; name: string | null }>([
      "create",
      "rotation runbook",
      "--tree",
      "share/auth",
      "--name",
      "jwt-rotation",
    ]);
    expect(created.name).toBe("jwt-rotation");

    // get by the folder/name path resolves to the same memory.
    const got = await meJson<{ id: string; name: string | null }>([
      "get",
      "share/auth/jwt-rotation",
    ]);
    expect(got.id).toBe(created.id);
    expect(got.name).toBe("jwt-rotation");

    // a bare name conflict errors; --replace overwrites in place (same id).
    const dup = await me([
      "create",
      "v2",
      "--tree",
      "share/auth",
      "--name",
      "jwt-rotation",
    ]);
    expect(dup.code).not.toBe(0);
    const replaced = await meJson<{
      id: string;
      content: string;
      versionHash: string;
    }>([
      "create",
      "v2",
      "--tree",
      "share/auth",
      "--name",
      "jwt-rotation",
      "--replace",
    ]);
    expect(replaced.id).toBe(created.id);
    expect(replaced.content).toBe("v2");

    // rename via update addressed by path.
    const renamed = await meJson<{ name: string | null }>([
      "update",
      "share/auth/jwt-rotation",
      "--version-hash",
      replaced.versionHash,
      "--name",
      "rotation",
    ]);
    expect(renamed.name).toBe("rotation");

    // delete the named memory by its path (no flag needed — a non-UUID arg is
    // always a tree/name path that deletes at most one memory).
    const del = await meJson<{ deleted: boolean }>([
      "delete",
      "share/auth/rotation",
    ]);
    expect(del.deleted).toBe(true);
  });

  test("6c. update --name '' clears the name", async () => {
    const created = await meJson<{ id: string; versionHash: string }>([
      "create",
      "clearable",
      "--tree",
      "share",
      "--name",
      "tmp",
    ]);
    const cleared = await meJson<{ name: string | null }>([
      "update",
      created.id,
      "--version-hash",
      created.versionHash,
      "--name",
      "",
    ]);
    expect(cleared.name).toBeNull();
  });

  test("6d. deltree: --dry-run previews without deleting; --yes deletes the subtree", async () => {
    await meJson(["create", "a", "--tree", "share/deltree_demo"]);
    await meJson(["create", "b", "--tree", "share/deltree_demo/sub"]);

    // delete <path> only ever targets a single named memory — with no memory
    // named 'deltree_demo' at share/, it errors and never touches the subtree
    // beneath it, and the error points at deltree.
    const single = await me(["delete", "share/deltree_demo"]);
    expect(single.code).not.toBe(0);
    expect(`${single.stdout}${single.stderr}`).toContain(
      "deltree share/deltree_demo",
    );
    expect(
      (await meJson<{ count: number }>(["count", "share/deltree_demo"])).count,
    ).toBe(2);

    // deltree --dry-run reports the count but deletes nothing.
    const dry = await meJson<{ dryRun: boolean; count: number }>([
      "deltree",
      "share/deltree_demo",
      "--dry-run",
    ]);
    expect(dry.dryRun).toBe(true);
    expect(dry.count).toBe(2);
    expect(
      (await meJson<{ count: number }>(["count", "share/deltree_demo"])).count,
    ).toBe(2);

    // deltree --yes deletes the whole subtree.
    const del = await meJson<{ count: number }>([
      "deltree",
      "share/deltree_demo",
      "--yes",
    ]);
    expect(del.count).toBe(2);
    expect(
      (await meJson<{ count: number }>(["count", "share/deltree_demo"])).count,
    ).toBe(0);
  });

  test("6e. name validation: create --name '' rejected; bad path fails validation not NOT_FOUND", async () => {
    // create --name "" must fail fast (empty is never a valid name) rather than
    // silently creating an unnamed memory.
    const emptyName = await me([
      "create",
      "x",
      "--tree",
      "share",
      "--name",
      "",
    ]);
    expect(emptyName.code).not.toBe(0);
    // and nothing was created at that tree under an empty name
    expect(
      `${emptyName.stdout}${emptyName.stderr}`.toLowerCase(),
    ).not.toContain("created memory");

    // A path with a trailing slash (empty leaf) is a validation error, not a
    // NOT_FOUND — the leaf must be a valid memory name.
    const badPath = await me(["get", "share/auth/"]);
    expect(badPath.code).not.toBe(0);
    expect(`${badPath.stdout}${badPath.stderr}`.toLowerCase()).not.toContain(
      "not found",
    );
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
    // An agent joins with owner over its own (nested) home, but the fox memory
    // lives under `share`; grant read there so the agent can see it (its access
    // is still clamped to the owner's, which here includes share).
    await meJson(["access", "grant", agent.id, "share", "r"]);
    const key = await meJson<{ id: string; key: string }>([
      "apikey",
      "create",
      "--agent",
      agent.id,
    ]);
    expect(key.key).toMatch(/^me\./);

    // Search with ONLY the api key — no session token. The agent's global key
    // plus X-Me-Space (ME_SPACE) selects the space; this exercises the CLI's
    // api-key auth path against the real server end-to-end.
    const agentEnv = { ME_API_KEY: key.key, ME_SESSION_TOKEN: "" };
    const res = await meJson<{ total: number }>(
      ["search", "--fulltext", "fox"],
      agentEnv,
    );
    expect(res.total).toBeGreaterThan(0);

    // TNT-139: the same agent key now drives the account-scoped *reads* on the
    // user RPC too — authn establishes *who*, the server authorizes per-method.
    // whoami reports the agent's own identity (kind "a", no email).
    const who = await meJson<{
      identity: { id: string; kind: string; email: string | null };
      auth: string;
    }>(["whoami"], agentEnv);
    expect(who.identity.id).toBe(agent.id);
    expect(who.identity.kind).toBe("a");
    expect(who.identity.email).toBeNull();
    // An agent authenticates with its api key.
    expect(who.auth).toBe("agent");

    // space.list returns the spaces the agent is admitted to.
    const spaces = await meJson<{ spaces: { slug: string }[] }>(
      ["space", "list"],
      agentEnv,
    );
    expect(spaces.spaces.some((s) => s.slug === spaceSlug)).toBe(true);

    // …but account management stays user-only: the CLI no longer pre-empts with
    // a session gate, so the server's FORBIDDEN surfaces instead (non-zero exit).
    const denied = await me(["agent", "list"], agentEnv);
    expect(denied.code).not.toBe(0);
  });

  test("7a1. act-as-agent (X-Me-As-Agent): a human session runs as one of its agents, constrained", async () => {
    // Set up an owned agent that is a space member with read on `share`.
    const agent = await meJson<{ id: string }>([
      "agent",
      "create",
      `asbot-${rand()}`,
    ]);
    await me(["agent", "add", agent.id]);
    await meJson(["access", "grant", agent.id, "share", "r"]);

    // Something to find under `share` (created by the human, before switching).
    const needle = `asagent${rand()}`;
    await meJson(["create", `act-as probe ${needle}`, "--tree", "share"]);

    // Agent mode: the SESSION token (no api key) + ME_AS_AGENT selects the agent
    // on both endpoints. whoami reports the AGENT identity (kind "a", null email).
    const asAgentEnv = { ME_AS_AGENT: agent.id };
    const who = await meJson<{
      identity: { id: string; kind: string; email: string | null };
    }>(["whoami"], asAgentEnv);
    expect(who.identity.id).toBe(agent.id);
    expect(who.identity.kind).toBe("a");
    expect(who.identity.email).toBeNull();

    // space.list works in agent mode (an agent-allowed read) and shows the space.
    const spaces = await meJson<{ spaces: { slug: string }[] }>(
      ["space", "list"],
      asAgentEnv,
    );
    expect(spaces.spaces.some((s) => s.slug === spaceSlug)).toBe(true);

    // A memory op is constrained to the agent's access — read@share lets it find
    // the probe, but not write a new memory there. The same write succeeds as
    // the human, proving this would fail if X-Me-As-Agent were not forwarded.
    const res = await meJson<{ total: number }>(
      ["search", "--fulltext", needle],
      asAgentEnv,
    );
    expect(res.total).toBeGreaterThan(0);
    const deniedWrite = await me(
      ["create", `agent write denied ${rand()}`, "--tree", "share", "--json"],
      asAgentEnv,
    );
    expect(deniedWrite.code).not.toBe(0);
    await meJson([
      "create",
      `human write allowed ${rand()}`,
      "--tree",
      "share",
    ]);

    // Management ops fail server-side in agent mode (FORBIDDEN → non-zero exit).
    const deniedAgentList = await me(["agent", "list"], asAgentEnv);
    expect(deniedAgentList.code).not.toBe(0);
    const deniedKeyCreate = await me(["apikey", "create"], asAgentEnv);
    expect(deniedKeyCreate.code).not.toBe(0);

    // Local user-session management is the explicit client-side exception:
    // login/logout refuse act-as mode rather than managing the human's session
    // from an agent-marked shell.
    const deniedLogin = await me(["login", "--json"], asAgentEnv);
    expect(deniedLogin.code).not.toBe(0);
    expect(JSON.parse(deniedLogin.stdout)).toMatchObject({
      code: "ACT_AS_AGENT_UNSUPPORTED",
    });
    const deniedLogout = await me(["logout", "--json"], asAgentEnv);
    expect(deniedLogout.code).not.toBe(0);
    expect(JSON.parse(deniedLogout.stdout)).toMatchObject({
      code: "ACT_AS_AGENT_UNSUPPORTED",
    });
    // Refused logout must not clear the stored human session.
    const stillLoggedIn = await meJson<{ identity: { kind: string } }>([
      "whoami",
    ]);
    expect(stillLoggedIn.identity.kind).toBe("u");

    // The --as-agent global flag is required-value, so it does NOT eat the
    // `search` subcommand nor its query.
    const viaFlag = await meJson<{ total: number }>([
      "--as-agent",
      agent.id,
      "search",
      "--fulltext",
      needle,
    ]);
    expect(viaFlag.total).toBeGreaterThan(0);

    // apikey create --agent still works when NOT in agent mode (no flag clash).
    const key = await meJson<{ key: string }>([
      "apikey",
      "create",
      "--agent",
      agent.id,
    ]);
    expect(key.key).toMatch(/^me\./);
  });

  test("7a2. groups resolve by name: grant by group name + groups are not nestable (TNT-160)", async () => {
    const groupName = `team-${rand()}`;
    const group = await meJson<{ id: string }>(["group", "create", groupName]);

    // TNT-160: grant access to the group BY NAME (previously only the id
    // worked, because groups weren't on the roster that resolve reads).
    const granted = await meJson<{ principalId: string }>([
      "access",
      "grant",
      groupName,
      "share",
      "r",
    ]);
    expect(granted.principalId).toBe(group.id);

    // the grant is now listed against the group id
    const listed = await meJson<{
      grants: { principalId: string; treePath: string }[];
    }>(["access", "list", groupName]);
    expect(
      listed.grants.some(
        (g) => g.principalId === group.id && g.treePath === "/share",
      ),
    ).toBe(true);

    // Groups are not nestable: a group name in the <member> slot is excluded
    // from member resolution, so `me group add` rejects it with a clear error.
    const nestedName = `team-${rand()}`;
    await meJson(["group", "create", nestedName]);
    const nest = await me(["group", "add", groupName, nestedName]);
    expect(nest.code).not.toBe(0);
    expect(`${nest.stdout}${nest.stderr}`.toLowerCase()).toContain(
      "is a group",
    );
  });

  test("7a3. admin groups: create --space-admin, list shows space-admin, set-space-admin toggles", async () => {
    // create as an admin group
    const adminName = `leads-${rand()}`;
    const created = await meJson<{ id: string; isSpaceAdmin: boolean }>([
      "group",
      "create",
      adminName,
      "--space-admin",
    ]);
    expect(created.isSpaceAdmin).toBe(true);

    // `me group list` surfaces the space-admin flag
    const listed = await meJson<{
      groups: { id: string; isSpaceAdmin: boolean }[];
    }>(["group", "list"]);
    expect(listed.groups.find((g) => g.id === created.id)?.isSpaceAdmin).toBe(
      true,
    );

    // demote by name with --off, then re-promote
    const demoted = await meJson<{ isSpaceAdmin: boolean; updated: boolean }>([
      "group",
      "set-space-admin",
      adminName,
      "--off",
    ]);
    expect(demoted).toMatchObject({ isSpaceAdmin: false, updated: true });

    const promoted = await meJson<{ isSpaceAdmin: boolean }>([
      "group",
      "set-space-admin",
      adminName,
    ]);
    expect(promoted.isSpaceAdmin).toBe(true);
  });

  test("7b. personal access tokens: self-default create/list, no same-day collision", async () => {
    // `me apikey create` with no agent mints a PAT for the caller. Two unnamed
    // PATs minted back-to-back must NOT collide on `unique (member_id, name)` —
    // the default name carries a random suffix. (This is the bug TNT-145 fixes.)
    const pat1 = await meJson<{ id: string; key: string }>([
      "apikey",
      "create",
    ]);
    const pat2 = await meJson<{ id: string; key: string }>([
      "apikey",
      "create",
    ]);
    expect(pat1.key).toMatch(/^me\./);
    expect(pat2.key).toMatch(/^me\./);
    expect(pat2.id).not.toBe(pat1.id);

    // A named PAT is now possible (the old `--self` shape couldn't take a name).
    const named = await meJson<{ id: string }>([
      "apikey",
      "create",
      `pat-${rand()}`,
    ]);

    // `me apikey list` (no --agent) lists the caller's OWN keys — all three.
    const { apiKeys } = await meJson<{ apiKeys: { id: string }[] }>([
      "apikey",
      "list",
    ]);
    const ids = new Set(apiKeys.map((k) => k.id));
    expect(ids.has(pat1.id)).toBe(true);
    expect(ids.has(pat2.id)).toBe(true);
    expect(ids.has(named.id)).toBe(true);

    // The PAT authenticates as the user themselves (kind "u"), no session.
    const patEnv = { ME_API_KEY: pat1.key, ME_SESSION_TOKEN: "" };
    const who = await meJson<{ identity: { kind: string }; auth: string }>(
      ["whoami"],
      patEnv,
    );
    expect(who.identity.kind).toBe("u");
    // A user PAT is an api key acting as the user themselves.
    expect(who.auth).toBe("pat");
  });

  test("8. `me claude import` backfills work that predates the hook", async () => {
    // The scenario: a user does a bunch of Claude Code work BEFORE installing
    // the capture hook (no hook fires for it), then installs the hook (which
    // begins capturing new sessions live), then runs `me claude import`. The
    // pre-install work must be backfilled — the importer has no lower time
    // bound tied to hook install; it sweeps every transcript and dedupes by
    // deterministic message id.
    const root = await mkdtemp(join(tmpdir(), "me-e2e-backfill-"));
    const projDir = join(root, "proj");
    await mkdir(projDir, { recursive: true });

    // cwd "/work/backfill-proj" → no git repo on disk → slug = basename, so
    // both sessions land under the same tree.
    const cwd = "/work/backfill-proj";
    const tree = `${homeProjects}.backfill_proj.agent_sessions`;

    const mkMsg =
      (sessionId: string) =>
      (i: number, type: "user" | "assistant", text: string) => ({
        type,
        uuid: `${sessionId}-${type}-${i}`,
        timestamp: `2026-02-01T00:00:0${i}.000Z`,
        sessionId,
        cwd,
        message:
          type === "user"
            ? { content: text }
            : { content: [{ type: "text", text }], model: "claude-x" },
      });

    const writeTranscript = async (sessionId: string, prefix: string) => {
      const m = mkMsg(sessionId);
      const lines = [
        m(0, "user", `${prefix} first question`),
        m(1, "assistant", `${prefix} first answer`),
        m(2, "user", `${prefix} second question`),
        m(3, "assistant", `${prefix} second answer`),
      ];
      const path = join(projDir, `${sessionId}.jsonl`);
      await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"));
      return path;
    };

    // 1. Pre-install work: a transcript sits on disk; NO hook ever fires for
    //    it. It must not be in the engine yet.
    const oldSession = `pre-install-${rand()}`;
    await writeTranscript(oldSession, "old");
    expect(await countBySession(oldSession)).toBe(0);

    // 2. Install the hook (it now captures live) and let it import a NEW
    //    session — the real `me claude hook` path, reading from stdin.
    const newSession = `post-install-${rand()}`;
    const newTranscript = await writeTranscript(newSession, "new");
    const hook = await meStdin(
      ["claude", "hook", "--event", "stop"],
      JSON.stringify({
        transcript_path: newTranscript,
        session_id: newSession,
      }),
    );
    expect(hook.code, hook.stderr).toBe(0);
    // The hook captured only the post-install session — the old one is still
    // absent (this is exactly the gap `me claude import` must close).
    expect(await countBySession(newSession)).toBe(4);
    expect(await countBySession(oldSession)).toBe(0);

    // 3. Run the import (canonical spelling; test 9 covers the
    //    `me claude import` alias).
    const imp = await me(["import", "claude", "--source", root]);
    expect(imp.code, imp.stderr).toBe(0);

    // 4. The pre-install work is now backfilled, and the hook's live capture
    //    was not duplicated.
    expect(await countBySession(oldSession)).toBe(4);
    expect(await countBySession(newSession)).toBe(4);
    expect(await countUnder(tree)).toBe(8);

    await rm(root, { recursive: true, force: true });
  });

  test("8b. `me claude init` backfills sessions and writes a CLAUDE.md pointer", async () => {
    // `me claude init` is the one-shot setup command. Two steps exercised
    // here:
    //   1. import THIS project's existing sessions (sessions whose recorded
    //      cwd is at/under init's cwd — init is per-project setup; the
    //      machine-wide sweep is `me import claude`);
    //   2. record the project's memory location in the project's CLAUDE.md
    //      (the project = init's cwd; not a git repo here → CLAUDE.md lands in
    //      that dir, slug = its basename).
    // The project we run `init` in — a non-git temp dir with a known basename
    // so the derived slug is predictable. CLAUDE.md will be written here, and
    // the transcript's session records this dir as its cwd, so the session
    // tree and the CLAUDE.md pointer name the same project.
    const projectRoot = await mkdtemp(join(tmpdir(), "me-e2e-initcwd-"));
    const projectDir = join(projectRoot, "initcwd");
    await mkdir(projectDir, { recursive: true });
    // The recorded session cwd must be the REAL path (as Claude Code would
    // record it): macOS tmpdir is a symlink (/var/folders → /private/var),
    // and init filters against the resolved process.cwd().
    const projectCwd = await realpath(projectDir);

    const sessionId = `init-${rand()}`;
    const foreignId = `foreign-${rand()}`;
    const tree = `${homeProjects}.initcwd.agent_sessions`;
    const mkMsg = (
      sid: string,
      cwd: string,
      i: number,
      type: "user" | "assistant",
      text: string,
    ) => ({
      type,
      uuid: `${sid}-${type}-${i}`,
      timestamp: `2026-03-01T00:00:0${i}.000Z`,
      sessionId: sid,
      cwd,
      message:
        type === "user"
          ? { content: text }
          : { content: [{ type: "text", text }], model: "claude-x" },
    });
    // Mirror Claude Code's on-disk layout: each transcript lives in a
    // directory named after the session cwd (encoded) — the scoped import
    // prunes by that name, so a literal fixture dir would never be scanned.
    const writeTranscript = async (
      sid: string,
      cwd: string,
      prefix: string,
    ) => {
      const dir = join(tmpHome, ".claude", "projects", encodeProjectDir(cwd));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${sid}.jsonl`),
        [
          mkMsg(sid, cwd, 0, "user", `${prefix} first question`),
          mkMsg(sid, cwd, 1, "assistant", `${prefix} first answer`),
          mkMsg(sid, cwd, 2, "user", `${prefix} second question`),
          mkMsg(sid, cwd, 3, "assistant", `${prefix} second answer`),
        ]
          .map((l) => JSON.stringify(l))
          .join("\n"),
      );
    };
    await writeTranscript(sessionId, projectCwd, "init");
    // A session from a DIFFERENT project must not be swept up by init.
    await writeTranscript(foreignId, "/work/other-proj", "foreign");

    // Pre-init: nothing captured, no CLAUDE.md.
    expect(await countBySession(sessionId)).toBe(0);

    // The CLAUDE.md pointer step is gated on Claude Code being installed
    // (Bun.which("claude")) — fake the binary so this test is deterministic
    // regardless of whether the real CLI happens to be on PATH here.
    const fakeBinDir = await fakeHarnessBins(["claude"]);
    const initEnv = { PATH: `${fakeBinDir}:${process.env.PATH}` };

    // Run `init` FROM the project dir so its cwd → slug → CLAUDE.md location.
    const init = await me(["project", "init"], initEnv, projectDir);
    expect(init.code, init.stderr).toBe(0);

    // Step 1: this project's session was backfilled; the foreign one wasn't.
    expect(await countBySession(sessionId)).toBe(4);
    expect(await countUnder(tree)).toBe(4);
    expect(await countBySession(foreignId)).toBe(0);

    // Step 2: the capture-enable step wrote the committed per-project opt-in.
    const meConfig = await readFile(
      join(projectDir, ".me", "config.yaml"),
      "utf8",
    );
    expect(meConfig).toContain("capture: true");

    // Step 3: CLAUDE.md now points at this project's memories.
    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("memory-engine:start");
    expect(claudeMd).toContain("~/projects/initcwd");
    expect(claudeMd).toContain("~/projects/initcwd/agent_sessions");
    expect(claudeMd).toContain("~/projects/initcwd/git_history");

    // Re-running is idempotent: still exactly one managed block.
    const init2 = await me(["project", "init"], initEnv, projectDir);
    expect(init2.code, init2.stderr).toBe(0);
    const claudeMd2 = await readFile(join(projectDir, "CLAUDE.md"), "utf8");
    expect(claudeMd2.split("memory-engine:start").length - 1).toBe(1);

    await rm(fakeBinDir, { recursive: true, force: true });
    for (const cwd of [projectCwd, "/work/other-proj"]) {
      await rm(join(tmpHome, ".claude", "projects", encodeProjectDir(cwd)), {
        recursive: true,
        force: true,
      });
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("8c. `me project init` honors --skip-transcript-import-claude / --skip-claude-md", async () => {
    // Non-interactive (piped) init runs every step except those turned off by
    // a --skip-<step> flag. Verify each flag suppresses exactly its step.
    // Each case gets its own project dir + a transcript recorded IN that dir
    // (init's import is scoped to the project it runs in), stored under the
    // Claude Code encoded-cwd directory layout the scoped import prunes by.
    const transcriptDirs: string[] = [];
    const mkProject = async (name: string) => {
      const root = await mkdtemp(join(tmpdir(), "me-e2e-skip-"));
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      return { root, dir };
    };
    const writeTranscript = async (sid: string, cwd: string) => {
      const mkMsg = (i: number, type: "user" | "assistant") => ({
        type,
        uuid: `${sid}-${type}-${i}`,
        timestamp: `2026-04-01T00:00:0${i}.000Z`,
        sessionId: sid,
        cwd,
        message:
          type === "user"
            ? { content: `q${i}` }
            : {
                content: [{ type: "text", text: `a${i}` }],
                model: "claude-x",
              },
      });
      const dir = join(tmpHome, ".claude", "projects", encodeProjectDir(cwd));
      transcriptDirs.push(dir);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${sid}.jsonl`),
        [
          mkMsg(0, "user"),
          mkMsg(1, "assistant"),
          mkMsg(2, "user"),
          mkMsg(3, "assistant"),
        ]
          .map((l) => JSON.stringify(l))
          .join("\n"),
      );
    };

    // The CLAUDE.md pointer step is gated on Claude Code being installed —
    // fake the binary so both cases below are deterministic regardless of
    // what's actually on PATH wherever this suite runs.
    const fakeBinDir = await fakeHarnessBins(["claude"]);
    const initEnv = { PATH: `${fakeBinDir}:${process.env.PATH}` };

    // --skip-transcript-import-claude: CLAUDE.md is written, but this
    // project's session is NOT imported (it would have been without the
    // flag).
    const a = await mkProject("skipimport");
    const sessionA = `skipa-${rand()}`;
    await writeTranscript(sessionA, await realpath(a.dir));
    const r1 = await me(
      ["project", "init", "--skip-transcript-import-claude"],
      initEnv,
      a.dir,
    );
    expect(r1.code, r1.stderr).toBe(0);
    expect(await countBySession(sessionA)).toBe(0);
    expect(existsSync(join(a.dir, "CLAUDE.md"))).toBe(true);

    // --skip-claude-md: the project's session imports, but no CLAUDE.md.
    const b = await mkProject("skipclaudemd");
    const sessionB = `skipb-${rand()}`;
    await writeTranscript(sessionB, await realpath(b.dir));
    const r2 = await me(
      ["project", "init", "--skip-claude-md"],
      initEnv,
      b.dir,
    );
    expect(r2.code, r2.stderr).toBe(0);
    expect(await countBySession(sessionB)).toBe(4);
    expect(existsSync(join(b.dir, "CLAUDE.md"))).toBe(false);

    await rm(fakeBinDir, { recursive: true, force: true });
    for (const dir of transcriptDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    await rm(a.root, { recursive: true, force: true });
    await rm(b.root, { recursive: true, force: true });
  });

  test("8i. `me claude init`/`me opencode init` are retired — error and redirect, run nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "me-e2e-retired-init-"));
    const projectDir = join(root, "retired");
    await mkdir(projectDir, { recursive: true });
    const sessionId = `retired-${rand()}`;
    const cwd = await realpath(projectDir);
    const dir = join(tmpHome, ".claude", "projects", encodeProjectDir(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      [
        {
          type: "user",
          uuid: `${sessionId}-user-0`,
          timestamp: "2026-06-01T00:00:00.000Z",
          sessionId,
          cwd,
          message: { content: "q0" },
        },
        {
          type: "assistant",
          uuid: `${sessionId}-assistant-1`,
          timestamp: "2026-06-01T00:00:01.000Z",
          sessionId,
          cwd,
          message: {
            content: [{ type: "text", text: "a1" }],
            model: "claude-x",
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );

    for (const args of [
      ["claude", "init"],
      // Old flags from both retired commands must not trip a Commander
      // parse error — they're accepted and ignored, never read.
      ["claude", "init", "--skip-transcript-import"],
      ["opencode", "init"],
      ["opencode", "init", "--scope", "project", "--skip-mcp-install"],
    ]) {
      const r = await me(args, undefined, projectDir);
      expect(r.code, r.stderr).toBe(1);
      expect(r.stderr).toContain("has been removed");
      expect(r.stderr).toContain("me project init");
    }

    // None of the above ran anything — no import, no CLAUDE.md/AGENTS.md.
    expect(await countBySession(sessionId)).toBe(0);
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);

    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  // Run git in `dir`, isolated from the developer's git config (gpg
  // signing, hooks, templates), with deterministic commit dates.
  async function git(
    dir: string,
    args: string[],
    dateIso?: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    const proc = Bun.spawn(
      [
        "git",
        "-C",
        dir,
        "-c",
        "user.name=E2E",
        "-c",
        "user.email=e2e@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          ...(dateIso
            ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
            : {}),
          // Spawned hooks inherit this env — the git-hook test merges
          // cliEnv() here so the hook's `me import git` can reach the server.
          ...(extraEnv ?? {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    }
  }

  test("8d. `me import git` imports commit history, idempotently and incrementally", async () => {
    // A real repo with a known-basename root so the slug (no remote →
    // basename) and therefore the tree are predictable.
    const root = await mkdtemp(join(tmpdir(), "me-e2e-git-"));
    const name = `gitproj${rand()}`;
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    const tree = `${homeProjects}.${name}.git_history`;
    // What the CLI composes + reports client-side (normalized server-side to
    // the `home.<id>`-prefixed `tree` above).
    const rawTree = `~/projects.${name}.git_history`;

    await git(repo, ["init", "-q", "-b", "main"]);
    const commitFile = async (file: string, msg: string, dateIso: string) => {
      await writeFile(join(repo, file), `${msg}\n`);
      await git(repo, ["add", "."], dateIso);
      await git(repo, ["commit", "-q", "-m", msg], dateIso);
    };
    await commitFile("a.txt", "feat: add a", "2026-05-01T10:00:00Z");
    await commitFile("b.txt", "fix: adjust b", "2026-05-02T10:00:00Z");
    await commitFile("c.txt", "docs: describe c", "2026-05-03T10:00:00Z");

    // 1. First import: all three commits land under the project tree.
    const first = await meJson<{
      inserted: number;
      commitsWalked: number;
      tree: string;
    }>(["import", "git", repo]);
    expect(first.tree).toBe(rawTree);
    expect(first.commitsWalked).toBe(3);
    expect(first.inserted).toBe(3);
    expect(await countUnder(tree)).toBe(3);

    // Spot-check one record's shape: type/sha meta + commit-date temporal +
    // file list in the content.
    const [row] = await sql.unsafe(
      `select content, meta from metest_${spaceSlug}.memory
         where tree = $1::ltree and content like 'fix: adjust b%'`,
      [tree],
    );
    expect(row?.meta?.type).toBe("git_commit");
    expect(row?.meta?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.meta?.author_email).toBe("e2e@example.test");
    expect(row?.content).toContain("Files:");
    expect(row?.content).toContain("b.txt (+1 -0)");

    // Thread links: commits chain via $prev along the first-parent line, with
    // the canonical /tree/sha path form; the root commit (a) has none.
    // $prev paths are stamped client-side from the raw (~-form) tree.
    const gitPath = (sha: string) => `/${rawTree.replaceAll(".", "/")}/${sha}`;
    const chain = await sql.unsafe(
      `select meta->>'sha' as sha, meta->>'$prev' as prev
         from metest_${spaceSlug}.memory
         where tree = $1::ltree
         order by (meta->>'commit_date')`,
      [tree],
    );
    expect(chain).toHaveLength(3);
    expect(chain[0]?.prev).toBeNull(); // root commit: no $prev
    expect(chain[1]?.prev).toBe(gitPath(chain[0]?.sha)); // b → a
    expect(chain[2]?.prev).toBe(gitPath(chain[1]?.sha)); // c → b

    // 2. Plain re-run: the high-water commit is HEAD → incremental walk of
    //    an empty range; nothing re-sent, nothing duplicated.
    const rerun = await meJson<{ inserted: number; commitsWalked: number }>([
      "import",
      "git",
      repo,
    ]);
    expect(rerun.commitsWalked).toBe(0);
    expect(rerun.inserted).toBe(0);
    expect(await countUnder(tree)).toBe(3);

    // 3. --full re-run: walks everything; deterministic ids make the server
    //    skip every row (`ON CONFLICT DO NOTHING`).
    const full = await meJson<{
      inserted: number;
      skipped: number;
      commitsWalked: number;
    }>(["import", "git", "--full", repo]);
    expect(full.commitsWalked).toBe(3);
    expect(full.inserted).toBe(0);
    expect(full.skipped).toBe(3);
    expect(await countUnder(tree)).toBe(3);

    // 4. New work: one regular commit + one body-less merge. The next plain
    //    run walks only the new range, imports the commit, and drops the
    //    boilerplate merge.
    await git(repo, ["checkout", "-q", "-b", "feat"], undefined);
    await commitFile("d.txt", "feat: add d", "2026-05-04T10:00:00Z");
    await git(repo, ["checkout", "-q", "main"]);
    await git(
      repo,
      ["merge", "-q", "--no-ff", "feat", "-m", "Merge branch 'feat'"],
      "2026-05-05T10:00:00Z",
    );
    const incr = await meJson<{
      inserted: number;
      commitsWalked: number;
      skippedMerges: number;
      range?: string;
    }>(["import", "git", repo]);
    expect(incr.range).toMatch(/^[0-9a-f]{40}\.\.HEAD$/);
    expect(incr.commitsWalked).toBe(2);
    expect(incr.inserted).toBe(1);
    expect(incr.skippedMerges).toBe(1);
    expect(await countUnder(tree)).toBe(4);

    // The incrementally-imported commit d links $prev back to c — its
    // first parent, imported in the FIRST run and NOT in this batch. This is
    // the out-of-batch-parent case: the high-water walk doesn't gate on the
    // batch set, so the link is stamped from the parent sha alone.
    const [dRow] = await sql.unsafe(
      `select meta->>'$prev' as prev from metest_${spaceSlug}.memory
         where tree = $1::ltree and content like 'feat: add d%'`,
      [tree],
    );
    expect(dRow?.prev).toBe(gitPath(chain[2]?.sha));

    // 5. --no-merges: the merge is walked but dropped in-process, so a commit
    //    whose first parent is that dropped merge still links $prev through to
    //    the merge's first parent (c) instead of dangling at the vanished merge.
    await commitFile("e.txt", "feat: add e", "2026-05-06T10:00:00Z");
    const noMerges = await meJson<{ inserted: number }>([
      "import",
      "git",
      "--full",
      "--no-merges",
      repo,
    ]);
    expect(noMerges.inserted).toBe(1); // just e; a–d already present, unchanged
    const [eRow] = await sql.unsafe(
      `select meta->>'$prev' as prev from metest_${spaceSlug}.memory
         where tree = $1::ltree and content like 'feat: add e%'`,
      [tree],
    );
    expect(eRow?.prev).toBe(gitPath(chain[2]?.sha)); // e → (through merge) → c

    await rm(root, { recursive: true, force: true });
  });

  test("8e. `me claude init` runs the git step; --skip-git-import suppresses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "me-e2e-gitinit-"));
    const name = `gitinit${rand()}`;
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    const tree = `${homeProjects}.${name}.git_history`;

    await git(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "x.txt"), "x\n");
    await git(repo, ["add", "."], "2026-05-01T10:00:00Z");
    await git(
      repo,
      ["commit", "-q", "-m", "feat: initial"],
      "2026-05-01T10:00:00Z",
    );

    // The CLAUDE.md pointer step is gated on Claude Code being installed —
    // fake the binary so this test is deterministic regardless of what's
    // actually on PATH wherever this suite runs.
    const fakeBinDir = await fakeHarnessBins(["claude"]);
    const initEnv = { PATH: `${fakeBinDir}:${process.env.PATH}` };

    // --skip-git-import: no commit memories.
    const skipped = await me(
      ["project", "init", "--skip-git-import"],
      initEnv,
      repo,
    );
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(await countUnder(tree)).toBe(0);

    // Plain init (non-interactive baseline) imports the repo's history and
    // the CLAUDE.md pointer names the git_history node.
    const init = await me(["project", "init"], initEnv, repo);
    expect(init.code, init.stderr).toBe(0);
    expect(await countUnder(tree)).toBe(1);
    const claudeMd = await readFile(join(repo, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain(`~/projects/${name}/git_history\``);

    await rm(fakeBinDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  test("8g. `me project init`'s transcript-import step is per-harness: only the tool with sessions runs", async () => {
    // A project with a Codex session and no Claude/OpenCode session at all —
    // only the Codex transcript-import step should find anything to
    // backfill; skip the pointer steps entirely so this test doesn't depend
    // on which harness binaries happen to be on PATH here (see 8b/8c/8e).
    const root = await mkdtemp(join(tmpdir(), "me-e2e-perharness-"));
    const name = `perharness${rand()}`;
    const projectDir = join(root, name);
    await mkdir(projectDir, { recursive: true });
    const projectCwd = await realpath(projectDir);

    const codexSessionId = "01234567-89ab-71de-9abc-def012345678";
    const codexDir = join(tmpHome, ".codex", "sessions", "2026", "05", "01");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, `rollout-2026-05-01T10-00-00-${codexSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-05-01T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: codexSessionId,
            timestamp: "2026-05-01T10:00:00.000Z",
            cwd: projectCwd,
            originator: "codex_cli_rs",
            cli_version: "0.107.0",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "m-1",
            role: "user",
            content: [{ type: "input_text", text: "codex first question" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "m-2",
            role: "assistant",
            content: [{ type: "output_text", text: "codex first answer" }],
          },
        }),
        // A second user message: importers default to skipping "trivial"
        // sessions (fewer than 2 user messages, see filters.ts) — this
        // session needs to survive that filter to actually get backfilled.
        JSON.stringify({
          timestamp: "2026-05-01T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "m-3",
            role: "user",
            content: [{ type: "input_text", text: "codex second question" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T10:00:04.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "m-4",
            role: "assistant",
            content: [{ type: "output_text", text: "codex second answer" }],
          },
        }),
      ].join("\n"),
    );

    const init = await me(
      ["project", "init", "--skip-claude-md", "--skip-agents-md"],
      undefined,
      projectDir,
    );
    expect(init.code, init.stderr).toBe(0);
    expect(await countBySession(codexSessionId)).toBe(4);

    const [row] = await sql.unsafe(
      `select distinct meta->>'source_tool' as tool from metest_${spaceSlug}.memory
         where meta->>'source_session_id' = $1`,
      [codexSessionId],
    );
    expect(row?.tool).toBe("codex");

    await rm(join(tmpHome, ".codex", "sessions"), {
      recursive: true,
      force: true,
    });
    await rm(root, { recursive: true, force: true });
  });

  test("8h. `me project init`'s CLAUDE.md/AGENTS.md pointer steps collapse into one write when the files are symlinked", async () => {
    // A common convention for projects supporting multiple AI tools: symlink
    // CLAUDE.md to AGENTS.md so there's only one file to maintain. Both
    // pointer specs share the same start marker, so independently writing
    // both into a symlinked pair wouldn't duplicate the block — but it WOULD
    // silently clobber one write with the other's wording, non-
    // deterministically depending on step order, absent the dedicated
    // detection this test covers.
    const root = await mkdtemp(join(tmpdir(), "me-e2e-symlinkmd-"));
    const projectDir = join(root, "symlinkmd");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "AGENTS.md"), "# Existing notes\n");
    await symlink(join(projectDir, "AGENTS.md"), join(projectDir, "CLAUDE.md"));

    // Both Claude Code and OpenCode "installed" — both pointer steps would
    // otherwise be independently available.
    const fakeBinDir = await fakeHarnessBins(["claude", "opencode"]);
    const initEnv = { PATH: `${fakeBinDir}:${process.env.PATH}` };

    const init = await me(
      [
        "project",
        "init",
        "--skip-transcript-import-claude",
        "--skip-transcript-import-codex",
        "--skip-transcript-import-opencode",
      ],
      initEnv,
      projectDir,
    );
    expect(init.code, init.stderr).toBe(0);

    const agentsMd = await readFile(join(projectDir, "AGENTS.md"), "utf8");
    const claudeMd = await readFile(join(projectDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toBe(agentsMd); // still the same file, via the symlink

    // Exactly one managed block — not duplicated, not clobbered-then-
    // rewritten twice.
    expect(agentsMd.split("memory-engine:start").length - 1).toBe(1);
    // The neutral wording won, not the Claude-specific one — correct
    // regardless of which of the two steps happened to run last.
    expect(agentsMd).toContain("captured/imported your coding agent");
    expect(agentsMd).not.toContain("captured/imported Claude Code");
    // The pre-existing content survived the upsert.
    expect(agentsMd).toContain("# Existing notes");

    await rm(fakeBinDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  test("8f. `me import git-hook` captures new commits via post-commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "me-e2e-githook-"));
    const name = `githook${rand()}`;
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    const tree = `${homeProjects}.${name}.git_history`;

    await git(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "."], "2026-05-01T10:00:00Z");
    await git(
      repo,
      ["commit", "-q", "-m", "feat: first"],
      "2026-05-01T10:00:00Z",
    );

    // Install: managed block written, executable, embeds the source invocation.
    const install = await me(["import", "git-hook", repo]);
    expect(install.code, install.stderr).toBe(0);
    const hookFile = join(repo, ".git", "hooks", "post-commit");
    const hook = await readFile(hookFile, "utf8");
    expect(hook).toContain(">>> memory-engine");
    expect(hook).toContain("import git");
    expect(hook).toContain(process.execPath); // bun + index.ts invocation
    const { mode } = await stat(hookFile);
    expect(mode & 0o111).not.toBe(0);

    // Re-install is idempotent: still exactly one managed block.
    const again = await me(["import", "git-hook", repo]);
    expect(again.code, again.stderr).toBe(0);
    const hook2 = await readFile(hookFile, "utf8");
    expect(hook2.split(">>> memory-engine").length - 1).toBe(1);

    // A commit fires the hook; its background incremental import catches up
    // the whole history (both commits). The hook child inherits the commit's
    // env, so merge cliEnv() in.
    await writeFile(join(repo, "b.txt"), "b\n");
    await git(repo, ["add", "."], "2026-05-02T10:00:00Z", cliEnv());
    await git(
      repo,
      ["commit", "-q", "-m", "feat: second"],
      "2026-05-02T10:00:00Z",
      cliEnv(),
    );
    const deadline = Date.now() + 30000;
    while ((await countUnder(tree)) < 2 && Date.now() < deadline) {
      await Bun.sleep(250);
    }
    expect(await countUnder(tree)).toBe(2);

    // --remove deletes the managed block (and here the whole file, since the
    // block was its only content).
    const removed = await me(["import", "git-hook", "--remove", repo]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(hookFile)).toBe(false);

    await rm(root, { recursive: true, force: true });
  });

  test("9. claude capture hook ↔ `me claude import` are cross-idempotent", async () => {
    // A minimal Claude Code session transcript on disk. The importer scans
    // <source>/<project-dir>/*.jsonl; the hook reads the file directly.
    const sessionId = `xact-${rand()}`;
    const root = await mkdtemp(join(tmpdir(), "me-e2e-transcript-"));
    const projDir = join(root, "proj");
    await mkdir(projDir, { recursive: true });
    const transcript = join(projDir, `${sessionId}.jsonl`);
    // Two user turns so the importer doesn't skip it as a trivial session
    // (the hook captures regardless; this makes both paths process all four).
    const mkMsg = (i: number, type: "user" | "assistant", text: string) => ({
      type,
      uuid: `${sessionId}-${type}-${i}`,
      timestamp: `2026-02-01T00:00:0${i}.000Z`,
      sessionId,
      cwd: "/work/idempotent-proj",
      message:
        type === "user"
          ? { content: text }
          : { content: [{ type: "text", text }], model: "claude-x" },
    });
    const lines = [
      mkMsg(0, "user", "first question"),
      mkMsg(1, "assistant", "first answer"),
      mkMsg(2, "user", "second question"),
      mkMsg(3, "assistant", "second answer"),
    ];
    await writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n"));

    // cwd "/work/idempotent-proj" → no git repo on disk → slug = basename.
    const tree = `${homeProjects}.idempotent_proj.agent_sessions`;

    // 1. Live capture via the real hook (reads transcript_path from stdin,
    //    auths with the session, writes via importTranscriptFile).
    const hook = await meStdin(
      ["claude", "hook", "--event", "stop"],
      JSON.stringify({ transcript_path: transcript, session_id: sessionId }),
    );
    expect(hook.code, hook.stderr).toBe(0);
    expect(await countUnder(tree)).toBe(4);

    // 2. `me claude import` over the SAME transcript → no new rows (same tree +
    //    deterministic ids ⇒ the importer dedupes against the hook's writes).
    const imp = await me(["claude", "import", "--source", root]);
    expect(imp.code, imp.stderr).toBe(0);
    expect(await countUnder(tree)).toBe(4);

    // 3. Re-run the hook → still idempotent.
    const hook2 = await meStdin(
      ["claude", "hook", "--event", "stop"],
      JSON.stringify({ transcript_path: transcript, session_id: sessionId }),
    );
    expect(hook2.code, hook2.stderr).toBe(0);
    expect(await countUnder(tree)).toBe(4);

    await rm(root, { recursive: true, force: true });
  });

  test("9e. capture gating: a project `.me` capture:false silences the hook", async () => {
    // The e2e harness opts into capture machine-wide (beforeAll); a project's
    // committed `capture: false` must still opt that project out — the hook
    // exits 0 with no output and writes nothing.
    const sessionId = `optout-${rand()}`;
    const root = await mkdtemp(join(tmpdir(), "me-e2e-optout-"));
    const projectDir = join(root, "optout-proj");
    await mkdir(join(projectDir, ".me"), { recursive: true });
    await writeFile(join(projectDir, ".me", "config.yaml"), "capture: false\n");
    const transcript = join(root, `${sessionId}.jsonl`);
    const msg = {
      type: "user",
      uuid: `${sessionId}-user-0`,
      timestamp: "2026-02-01T00:00:00.000Z",
      sessionId,
      cwd: projectDir,
      message: { content: "must not be captured" },
    };
    await writeFile(transcript, JSON.stringify(msg));

    const hook = await meStdin(
      ["claude", "hook", "--event", "stop"],
      JSON.stringify({
        transcript_path: transcript,
        session_id: sessionId,
        cwd: projectDir,
      }),
    );
    expect(hook.code).toBe(0);
    expect(hook.stderr).toBe(""); // silent — a deliberate opt-out, not an error
    expect(await countBySession(sessionId)).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Per-project routing for bulk imports (PR 4)
  // ---------------------------------------------------------------------------

  /** Write a 4-message transcript into `<sourceRoot>/<dirName>/<sid>.jsonl`. */
  async function writeRoutedTranscript(
    sourceRoot: string,
    dirName: string,
    sid: string,
    cwd: string,
  ): Promise<void> {
    const mk = (i: number, type: "user" | "assistant") => ({
      type,
      uuid: `${sid}-${type}-${i}`,
      timestamp: `2026-06-01T00:00:0${i}.000Z`,
      sessionId: sid,
      cwd,
      message:
        type === "user"
          ? { content: `q${i}` }
          : { content: [{ type: "text", text: `a${i}` }], model: "claude-x" },
    });
    const dir = join(sourceRoot, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sid}.jsonl`),
      [mk(0, "user"), mk(1, "assistant"), mk(2, "user"), mk(3, "assistant")]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
  }

  /** Run `me` with some env vars REMOVED — for flows where an env override
   *  would outrank the per-project `.me` under test (env > .me precedence). */
  async function meWithout(
    drop: string[],
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const env = cliEnv();
    for (const k of drop) delete env[k];
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, code: await proc.exited };
  }

  test("10. a bulk sweep routes each session by its own project's .me", async () => {
    // Three projects on disk: one pinning a shared tree, one plain (private
    // default), one pinning an UNTRUSTED server (skipped, tallied). The sweep
    // runs from a neutral cwd — routing must come from each session's cwd.
    const root = await mkdtemp(join(tmpdir(), "me-e2e-routed-"));
    const source = join(root, "transcripts");

    const treedDir = join(root, "treedproj");
    await mkdir(join(treedDir, ".me"), { recursive: true });
    await writeFile(
      join(treedDir, ".me", "config.yaml"),
      "tree: /share/projects/routedproj\n",
    );
    const plainDir = join(root, "plainproj");
    await mkdir(plainDir, { recursive: true });
    const evilDir = join(root, "evilproj");
    await mkdir(join(evilDir, ".me"), { recursive: true });
    await writeFile(
      join(evilDir, ".me", "config.yaml"),
      "server: https://attacker.example\n",
    );

    const sidTreed = `routed-treed-${rand()}`;
    const sidPlain = `routed-plain-${rand()}`;
    const sidEvil = `routed-evil-${rand()}`;
    await writeRoutedTranscript(
      source,
      "a",
      sidTreed,
      await realpath(treedDir),
    );
    await writeRoutedTranscript(
      source,
      "b",
      sidPlain,
      await realpath(plainDir),
    );
    await writeRoutedTranscript(source, "c", sidEvil, await realpath(evilDir));

    // Drop ME_SERVER: env outranks a `.me` server pin by design, so the
    // untrusted-server gate only engages when the server comes from config
    // (the stored default_server carries the base).
    const sweep = await meWithout(
      ["ME_SERVER"],
      ["import", "claude", "--source", source, "--include-temp-cwd", "--json"],
    );
    expect(sweep.code, sweep.stderr).toBe(0);
    const result = JSON.parse(sweep.stdout) as {
      inserted: number;
      sessionsProcessed: number;
      sessionSkipReasons: Record<string, number>;
    };

    // The .me-pinned project lands under ITS tree (no slug appended)…
    expect(await countBySession(sidTreed)).toBe(4);
    expect(await countUnder("share.projects.routedproj.agent_sessions")).toBe(
      4,
    );
    // …the plain project under the private per-slug default…
    expect(await countBySession(sidPlain)).toBe(4);
    expect(await countUnder(`${homeProjects}.plainproj.agent_sessions`)).toBe(
      4,
    );
    // …and the untrusted-server project is skipped + tallied, never written.
    expect(await countBySession(sidEvil)).toBe(0);
    expect(result.sessionSkipReasons.project_config_error).toBe(1);
    expect(result.sessionsProcessed).toBe(2);

    await rm(root, { recursive: true, force: true });
  });

  test("10b. a project pinning another space routes its sessions there", async () => {
    // A second space, created through the CLI (the creator gets owner@share).
    const created = await meJson<{ slug: string }>([
      "space",
      "create",
      `routed-space-${rand()}`,
    ]);
    const slug2 = created.slug;

    const root = await mkdtemp(join(tmpdir(), "me-e2e-xspace-"));
    const source = join(root, "transcripts");
    const projDir = join(root, "xspaceproj");
    await mkdir(join(projDir, ".me"), { recursive: true });
    await writeFile(
      join(projDir, ".me", "config.yaml"),
      `space: ${slug2}\ntree: /share/projects/xspaceproj\n`,
    );
    const sid = `xspace-${rand()}`;
    await writeRoutedTranscript(source, "x", sid, await realpath(projDir));

    // The sweep must run WITHOUT ME_SPACE (env would outrank every project's
    // .me space, per the documented precedence) — the base space comes from
    // the stored active_space instead.
    const sweep = await meWithout(
      ["ME_SPACE"],
      ["import", "claude", "--source", source, "--include-temp-cwd"],
    );
    expect(sweep.code, sweep.stderr).toBe(0);

    // Rows landed in the SECOND space's schema, under the project tree.
    const [row] = await sql.unsafe(
      `select count(*)::int as n from metest_${slug2}.memory
         where meta->>'source_session_id' = $1`,
      [sid],
    );
    expect(row?.n).toBe(4);
    // …and not in the base space.
    expect(await countBySession(sid)).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  test("10c. `me import git <repo>` honors the TARGET repo's .me from any cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "me-e2e-gitouter-"));
    const name = `gitouter${rand()}`;
    const repo = join(root, name);
    await mkdir(join(repo, ".me"), { recursive: true });
    await writeFile(
      join(repo, ".me", "config.yaml"),
      "tree: /share/projects/gitouterproj\n",
    );
    await git(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "."], "2026-06-01T10:00:00Z");
    await git(
      repo,
      ["commit", "-q", "-m", "feat: outer"],
      "2026-06-01T10:00:00Z",
    );

    // Run from a NEUTRAL cwd (tmpHome) — the target repo's .me must govern.
    const result = await meJson<{ tree: string; inserted: number }>(
      ["import", "git", repo],
      undefined,
      tmpHome,
    );
    expect(result.inserted).toBe(1);
    expect(result.tree).toBe("/share/projects/gitouterproj.git_history");
    expect(await countUnder("share.projects.gitouterproj.git_history")).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

  test("10d. a bulk sweep rejects an explicit --config-dir / ME_CONFIG_DIR", async () => {
    // A config-dir pin is a single-project concept; sweeps route per session,
    // so the combination is a loud error, not a silently ignored pin.
    const proc = Bun.spawn(
      [process.execPath, CLI, "import", "claude", "--source", tmpHome],
      {
        env: cliEnv({ ME_CONFIG_DIR: tmpHome }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    // clack renders errors on stdout in text mode.
    expect(stdout + stderr).toContain(
      "ME_CONFIG_DIR does not apply to session imports",
    );
  });

  test("9b. a stale importer_version is re-rendered in place on re-import", async () => {
    // The server's conditional upsert: re-importing a session rewrites any
    // row whose stored meta.importer_version differs from the current
    // importer's, and skips the rest — no client-side existing-state read.
    const sessionId = `stale-${rand()}`;
    const root = await mkdtemp(join(tmpdir(), "me-e2e-stale-"));
    const projDir = join(root, "proj");
    await mkdir(projDir, { recursive: true });
    const mkMsg = (i: number, type: "user" | "assistant", text: string) => ({
      type,
      uuid: `${sessionId}-${type}-${i}`,
      timestamp: `2026-05-01T00:00:0${i}.000Z`,
      sessionId,
      cwd: "/work/stale-proj",
      message:
        type === "user"
          ? { content: text }
          : { content: [{ type: "text", text }], model: "claude-x" },
    });
    await writeFile(
      join(projDir, `${sessionId}.jsonl`),
      [
        mkMsg(0, "user", "stale first question"),
        mkMsg(1, "assistant", "stale first answer"),
        mkMsg(2, "user", "stale second question"),
        mkMsg(3, "assistant", "stale second answer"),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );

    const first = await meJson<{ inserted: number }>([
      "import",
      "claude",
      "--source",
      root,
    ]);
    expect(first.inserted).toBe(4);

    // Rewind one row to look like an older importer build wrote it.
    const [stale] = await sql.unsafe(
      `update metest_${spaceSlug}.memory
         set content = 'STALE RENDER',
             meta = jsonb_set(meta, '{importer_version}', '"0"')
         where meta->>'source_session_id' = $1
           and meta->>'source_message_id' = $2
         returning id`,
      [sessionId, `${sessionId}-user-0`],
    );
    expect(stale?.id).toBeDefined();

    // Re-import: exactly the stale row is rewritten, the rest skip.
    const second = await meJson<{
      inserted: number;
      updated: number;
      skipped: number;
      failed: number;
    }>(["import", "claude", "--source", root]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.skipped).toBe(3);
    expect(second.failed).toBe(0);

    const [row] = await sql.unsafe(
      `select content, meta->>'importer_version' as v
         from metest_${spaceSlug}.memory where id = $1`,
      [stale?.id as string],
    );
    expect(row?.content).toBe("stale first question");
    expect(row?.v).toBe("1");

    await rm(root, { recursive: true, force: true });
  });

  test("9c. `me import` group: no bare default, memories ≡ memory import", async () => {
    // Bare `me import` is a group, not the old file-import alias: it prints
    // the subcommand list and exits non-zero.
    const bare = await me(["import"]);
    expect(bare.code).not.toBe(0);
    expect(bare.stdout + bare.stderr).toContain("memories");

    // Old muscle memory `me import <file>` no longer parses.
    const fileArg = await me(["import", "nosuch.md"]);
    expect(fileArg.code).not.toBe(0);
    expect(fileArg.stderr).toContain("unknown command");

    // The file importer lives at `me import memories`, with
    // `me memory import` as its alias — both write the same records.
    const record = (i: number) =>
      JSON.stringify({
        content: `import group probe ${i}`,
        tree: "share.importgroup",
      });
    const viaGroup = await meStdin(["import", "memories", "-"], record(1));
    expect(viaGroup.code, viaGroup.stderr).toBe(0);
    const viaAlias = await meStdin(["memory", "import", "-"], record(2));
    expect(viaAlias.code, viaAlias.stderr).toBe(0);
    expect(await countUnder("share.importgroup")).toBe(2);
  });

  test("9d. `me import memories` is idempotent — re-import skips, never errors", async () => {
    // Named record (no id): the (tree, name) slot is the idempotency key.
    const named = JSON.stringify({
      content: "idempotent named probe",
      tree: "share/idem",
      name: "probe",
    });
    const first = await meStdin(["import", "memories", "-", "--json"], named);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).imported).toBe(1);

    // Re-import identical content: skipped server-side, exit 0 (the
    // raise-by-default introduced in the SQL conflict model would otherwise
    // error here), and no duplicate row materializes.
    const again = await meStdin(["import", "memories", "-", "--json"], named);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).imported).toBe(0);
    expect(await countUnder("share.idem")).toBe(1);

    // Explicit-id record: the id is the idempotency key, and a skipped id is
    // reported back in `skippedIds`.
    const id = Bun.randomUUIDv7();
    const withId = JSON.stringify({
      content: "idempotent id probe",
      tree: "share/idem",
      id,
    });
    const idFirst = await meStdin(
      ["import", "memories", "-", "--json"],
      withId,
    );
    expect(idFirst.code, idFirst.stderr).toBe(0);
    expect(JSON.parse(idFirst.stdout).ids).toContain(id);

    const idAgain = await meStdin(
      ["import", "memories", "-", "--json"],
      withId,
    );
    expect(idAgain.code, idAgain.stderr).toBe(0);
    const r = JSON.parse(idAgain.stdout);
    expect(r.imported).toBe(0);
    expect(r.skippedIds).toContain(id);
    expect(await countUnder("share.idem")).toBe(2);
  });

  test("10. failure modes: bad space and missing auth exit non-zero", async () => {
    const badSpace = await me(["search", "--fulltext", "fox"], {
      ME_SPACE: "doesnotexist1",
    });
    expect(badSpace.code).not.toBe(0);

    const noAuth = await me(["whoami"], { ME_SESSION_TOKEN: "" });
    expect(noAuth.code).not.toBe(0);
  });

  test("11. space leave: a non-admin member self-removes, cascading their agent", async () => {
    const { env2 } = await seedSecondMember();

    // the member is in the space before leaving
    const before = await meJson<{ spaces: { slug: string }[] }>(
      ["space", "list"],
      env2,
    );
    expect(before.spaces.some((s) => s.slug === spaceSlug)).toBe(true);

    // they bring one of their own agents into the space (self-service)
    const agent = await meJson<{ id: string }>(
      ["agent", "create", `leaver-${rand()}`],
      env2,
    );
    await me(["agent", "add", agent.id], env2);
    const agentSpaces = await meJson<{ spaces: { slug: string }[] }>(
      ["agent", "spaces", agent.id],
      env2,
    );
    expect(agentSpaces.spaces.some((s) => s.slug === spaceSlug)).toBe(true);

    // leave (self-service, no admin) succeeds
    const left = await meJson<{ removed: boolean }>(
      ["space", "leave", "-y"],
      env2,
    );
    expect(left.removed).toBe(true);

    // the space is no longer on the member's roster…
    const after = await meJson<{ spaces: { slug: string }[] }>(
      ["space", "list"],
      env2,
    );
    expect(after.spaces.some((s) => s.slug === spaceSlug)).toBe(false);

    // …and the cascade removed the agent from the space too
    const agentAfter = await meJson<{ spaces: { slug: string }[] }>(
      ["agent", "spaces", agent.id],
      env2,
    );
    expect(agentAfter.spaces.some((s) => s.slug === spaceSlug)).toBe(false);
  });

  test("11a. the sole admin cannot leave (LAST_ADMIN)", async () => {
    // the primary identity is the space's only admin
    const r = await me(["space", "leave", "-y"]);
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).toContain("sole admin");
    // still a member (and still admin) after the rejected leave
    const who = await meJson<{ activeSpace: string }>(["whoami"]);
    expect(who.activeSpace).toBe(spaceSlug);
  });

  test("11b. an agent principal cannot leave — actionable error, not a bare FORBIDDEN", async () => {
    // an owned agent; run `space leave` AS that agent (ME_AS_AGENT) — whoami then
    // reports kind "a", and the CLI must reject with a clear message.
    const agent = await meJson<{ id: string }>([
      "agent",
      "create",
      `noleave-${rand()}`,
    ]);
    const r = await me(["space", "leave", "-y"], { ME_AS_AGENT: agent.id });
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).toContain(
      "only a user can leave",
    );
  });

  test("12. space remove-member: an admin removes an agent from the roster", async () => {
    // the admin creates an agent, adds it, then removes it from the space
    const agent = await meJson<{ id: string }>([
      "agent",
      "create",
      `evictee-${rand()}`,
    ]);
    await me(["agent", "add", agent.id]);
    const inSpace = await meJson<{ spaces: { slug: string }[] }>([
      "agent",
      "spaces",
      agent.id,
    ]);
    expect(inSpace.spaces.some((s) => s.slug === spaceSlug)).toBe(true);

    const removed = await meJson<{ removed: boolean }>([
      "space",
      "remove-member",
      agent.id,
      "-y",
    ]);
    expect(removed.removed).toBe(true);

    const gone = await meJson<{ spaces: { slug: string }[] }>([
      "agent",
      "spaces",
      agent.id,
    ]);
    expect(gone.spaces.some((s) => s.slug === spaceSlug)).toBe(false);
  });
});
