#!/usr/bin/env bun
//
// Reclaim orphaned integration-test schemas from the test database.
//
// Integration tests provision throwaway schemas and drop them in teardown, but
// a hard interruption (SIGKILL, OOM, a timed-out `beforeAll`) can leave one
// behind. This script sweeps those leftovers. It runs automatically before
// `test:db` (see package.json) and can be run by hand.
//
// SAFETY — this script issues `drop schema ... cascade`, so it only ever targets
// schema names that are impossible in production:
//
//   * `core_test_*` — core tests; production's control plane is the bare `core`.
//   * `metest_*`    — space tests; production spaces are `me_<slug>`. Tests
//                     deliberately provision under the `metest_` prefix (see
//                     packages/space/migrate/test-utils.ts) so they never share
//                     a name with a real space, and `metest_` does not start
//                     with the `me_` engine prefix.
//
// The result: pointed at a real database, this script is a no-op — neither
// pattern can match a production schema.
//
// By default it only drops schemas older than --older-than-min (default 60),
// using each schema's `version.at` timestamp. That keeps it safe to run as a
// pre-step even while another `test:db` invocation shares the database: that
// run's freshly-provisioned schemas are younger than the threshold and are left
// alone. Pass --all to ignore age (a deliberate full reset — only do this when
// nothing else is using the database).

import postgres, { type Sql } from "postgres";

const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres@127.0.0.1:5432/postgres";

// Production-impossible test schema patterns. core_test_<rand>, metest_<slug>.
const TEST_SCHEMA_PATTERNS = ["^core_test_[a-z0-9]+$", "^metest_[a-z0-9]{12}$"];

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

interface Options {
  all: boolean;
  olderThanMin: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { all: false, olderThanMin: 60, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: ./bun scripts/clean-test-schemas.ts [--all] [--older-than-min N] [--quiet]

Drops orphaned integration-test schemas from TEST_DATABASE_URL (default
${DEFAULT_TEST_DATABASE_URL}): core_test_* and metest_* schemas. Safe against
production databases (no-op there — neither pattern can match a real schema).

  --all                Ignore age; drop every matching schema. Use only when no
                       other test run shares the database.
  --older-than-min N   Only drop schemas older than N minutes (default 60).
  --quiet              Only print when something is dropped or on error.`,
      );
      process.exit(0);
    } else if (arg === "--all") {
      opts.all = true;
    } else if (arg === "--quiet") {
      opts.quiet = true;
    } else if (arg === "--older-than-min") {
      const next = argv[++i];
      const n = Number(next);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Invalid --older-than-min value: ${next}`);
        process.exit(2);
      }
      opts.olderThanMin = n;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

async function findCandidates(sql: Sql): Promise<string[]> {
  // OR the (constant, production-impossible) patterns as bound `~` tests.
  const match = TEST_SCHEMA_PATTERNS.map((p) => sql`n.nspname ~ ${p}`).reduce(
    (acc, frag) => sql`${acc} or ${frag}`,
  );
  const rows = await sql<{ schema: string }[]>`
    select n.nspname as schema
    from pg_namespace n
    where ${match}
    order by n.nspname
  `;
  return rows.map((r) => r.schema);
}

/**
 * Age of a schema in minutes from its singleton `version.at`, or null when the
 * schema has no readable version row (a partial/failed provision). In safe mode
 * those are skipped — they may belong to a concurrent run still provisioning.
 */
async function schemaAgeMinutes(
  sql: Sql,
  schema: string,
): Promise<number | null> {
  try {
    const rows = await sql.unsafe<{ age_min: number }[]>(
      `select extract(epoch from (now() - at)) / 60 as age_min
       from ${schema}.version
       limit 1`,
    );
    const [row] = rows;
    return row ? Number(row.age_min) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const log = (msg: string) => {
    if (!opts.quiet) console.error(msg);
  };

  // Short timeouts: never let cleanup hang a test run on a lock. statement_timeout
  // and lock_timeout are libpq startup params here, in milliseconds.
  const sql = postgres(testDatabaseUrl(), {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
    connection: { statement_timeout: 10_000, lock_timeout: 3_000 },
  });

  const dropped: string[] = [];
  try {
    const candidates = await findCandidates(sql);
    if (candidates.length === 0) {
      log("[clean-test-schemas] no test schemas found.");
      return;
    }

    for (const schema of candidates) {
      // Defense in depth: the patterns already constrain this, but never
      // interpolate a name that isn't a plain lowercase identifier.
      if (!SAFE_IDENTIFIER.test(schema) || schema.length > 63) {
        log(`[clean-test-schemas] skip ${schema}: unexpected identifier`);
        continue;
      }

      if (!opts.all) {
        const age = await schemaAgeMinutes(sql, schema);
        if (age === null) {
          log(`[clean-test-schemas] skip ${schema}: no version row (recent?)`);
          continue;
        }
        if (age < opts.olderThanMin) {
          log(
            `[clean-test-schemas] skip ${schema}: ${age.toFixed(0)}m old < ${opts.olderThanMin}m`,
          );
          continue;
        }
      }

      try {
        await sql.unsafe(`drop schema if exists ${schema} cascade`);
        dropped.push(schema);
      } catch (error) {
        log(`[clean-test-schemas] failed to drop ${schema}: ${error}`);
      }
    }
  } catch (error) {
    // Best-effort: never block the test run on a cleanup hiccup. If the database
    // is genuinely unreachable, the tests themselves will surface it.
    console.error(`[clean-test-schemas] skipped (cleanup error): ${error}`);
  } finally {
    await sql.end();
  }

  if (dropped.length > 0) {
    console.error(
      `[clean-test-schemas] dropped ${dropped.length} schema(s): ${dropped.join(", ")}`,
    );
  }
}

await main();
