#!/usr/bin/env bun
/**
 * Local development setup script.
 *
 * Creates databases if they don't exist. That's it.
 *
 * Everything else (bootstrap, migrations, encryption keys) is handled
 * automatically at server startup. This script only exists because
 * creating a database requires connecting to the 'postgres' database,
 * which the server doesn't do.
 *
 * Prerequisites:
 *   1. Postgres running (`./bun run pg`)
 *   2. .env filled in (ACCOUNTS_DATABASE_URL, ENGINE_DATABASE_URL)
 *
 * Usage:
 *   ./bun run setup
 */
import { SQL } from "bun";

// =============================================================================
// Env validation
// =============================================================================

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    console.error("Copy .env.sample to .env and fill in values.");
    process.exit(1);
  }
  return value;
}

const ACCOUNTS_DATABASE_URL = requireEnv("ACCOUNTS_DATABASE_URL");
const ENGINE_DATABASE_URL = requireEnv("ENGINE_DATABASE_URL");

// =============================================================================
// Database creation
// =============================================================================

/**
 * Extract the database name from a connection string and create it if missing.
 */
async function ensureDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const dbName = url.pathname.slice(1); // strip leading /

  // Connect to the default 'postgres' database to create ours
  url.pathname = "/postgres";
  const adminSql = new SQL(url.toString());

  try {
    const [{ exists }] = await adminSql`
      select exists (
        select 1 from pg_database where datname = ${dbName}
      ) as exists
    `;
    if (!exists) {
      await adminSql.unsafe(`create database ${dbName}`);
      console.log(`  Created database: ${dbName}`);
    } else {
      console.log(`  Database exists: ${dbName}`);
    }
  } finally {
    await adminSql.close();
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("=== Memory Engine: Local Dev Setup ===");
  console.log("");

  console.log("Ensuring databases exist...");
  await ensureDatabase(ACCOUNTS_DATABASE_URL);
  await ensureDatabase(ENGINE_DATABASE_URL);
  console.log("");

  console.log("Done! Start the server to run bootstrap + migrations:");
  console.log("  ./bun run server");
}

main().catch((error) => {
  console.error("");
  console.error(
    "Setup failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
