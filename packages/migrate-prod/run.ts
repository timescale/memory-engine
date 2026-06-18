#!/usr/bin/env bun
/**
 * Runner for the prod → multiplayer ETL (maintenance-window / all-at-once mode).
 *
 *   DATABASE_URL=postgresql://… ./bun packages/migrate-prod/run.ts
 *
 * Runs Phase A (auth/core + identities) then Phase B for every active engine
 * (rename-aside + provision + roster/grants + copy memories), in the one
 * database, and prints the report. This renames ALL old `me_<slug>` schemas, so
 * old-app traffic must be stopped first.
 *
 * For a zero-downtime, per-engine cutover instead, import the phase functions
 * (`migrateControlPlane`, `migrateEngine`) and drive them per the runbook
 * (PROD_MIGRATION_PLAN.md §7). Teardown (`dropLegacy`/`dropAccounts`) is always
 * a separate, explicit step after verification.
 */
import postgres from "postgres";
import { migrateProdToMultiplayer } from "./migrate";
import { DEFAULT_SCHEMAS } from "./schemas";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? process.env.ME_DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL (the single consolidated database).");
    process.exit(1);
  }
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  try {
    console.error("[migrate-prod] starting (maintenance-window mode)…");
    const report = await migrateProdToMultiplayer(sql, DEFAULT_SCHEMAS);
    console.log(JSON.stringify(report, null, 2));
    console.error(
      `[migrate-prod] done: ${report.identities} identities, ${report.engines.length} spaces, ` +
        `${report.skippedEngines.length} skipped, ${report.warnings.length} warnings. ` +
        "Legacy + accounts schemas left intact — drop them only after verifying cutover.",
    );
  } finally {
    await sql.end();
  }
}

await main();
