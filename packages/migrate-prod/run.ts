#!/usr/bin/env bun
/**
 * Runner for the prod → multiplayer ETL.
 *
 *   DB_ACCOUNTS=postgresql://…  \
 *   DB_SHARD=postgresql://…     \
 *   DATABASE_URL=postgresql://… \   # the NEW target database
 *   ./bun packages/migrate-prod/run.ts
 *
 * Reads identities from DB_ACCOUNTS and memories from DB_SHARD (both read-only),
 * writes the new model to the target database, and prints the report. The
 * sources are never modified — rollback is repointing the app at them.
 *
 * Run this BEFORE deploying the new app, then point the app's DATABASE_URL at the
 * same target database (its idempotent boot migration then re-runs as a no-op).
 * See PROD_MIGRATION_RUNBOOK.md.
 */
import postgres from "postgres";
import { migrateProdToMultiplayer } from "./migrate";
import { DEFAULT_CONFIG } from "./schemas";

function require_(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}.`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const accountsUrl = require_("DB_ACCOUNTS");
  const shardUrl = require_("DB_SHARD");
  const targetUrl = process.env.DATABASE_URL ?? process.env.DB_TARGET;
  if (!targetUrl) {
    console.error(
      "Set DATABASE_URL (or DB_TARGET) to the NEW target database.",
    );
    process.exit(1);
  }

  const accounts = postgres(accountsUrl, { max: 2, onnotice: () => {} });
  const shard = postgres(shardUrl, { max: 4, onnotice: () => {} });
  const target = postgres(targetUrl, { max: 4, onnotice: () => {} });
  try {
    console.error("[migrate-prod] starting: DB_ACCOUNTS + DB_SHARD → target…");
    const report = await migrateProdToMultiplayer(
      { accounts, shard, target },
      DEFAULT_CONFIG,
    );
    console.log(JSON.stringify(report, null, 2));
    console.error(
      `[migrate-prod] done: ${report.identities} identities, ${report.engines.length} spaces, ` +
        `${report.skippedEngines.length} skipped, ${report.warnings.length} warnings. ` +
        "Source databases untouched — decommission them only after verifying cutover.",
    );
  } finally {
    await Promise.all([accounts.end(), shard.end(), target.end()]);
  }
}

await main();
