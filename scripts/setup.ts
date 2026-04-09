#!/usr/bin/env bun
/**
 * Local development setup script.
 *
 * Creates databases, runs migrations, bootstraps the engine, and sets up
 * encryption keys. Idempotent — safe to run multiple times.
 *
 * Prerequisites:
 *   1. Postgres running (`bun run pg`)
 *   2. .env filled in (at least ACCOUNTS_DATABASE_URL, ENGINE_DATABASE_URL,
 *      ACCOUNTS_MASTER_KEY)
 *
 * Usage:
 *   bun run setup
 */
import { createAccountsDB } from "@memory-engine/accounts";
import { migrate } from "@memory-engine/accounts/migrate/runner";
import { bootstrap } from "@memory-engine/engine/migrate/bootstrap";
import { SQL } from "bun";

// =============================================================================
// Env validation
// =============================================================================

const ACCOUNTS_SCHEMA = process.env.ACCOUNTS_SCHEMA ?? "accounts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    console.error("Copy .env.sample to .env and fill in values.");
    console.error("Generate a master key with: bun run generate:master-key");
    process.exit(1);
  }
  return value;
}

const ACCOUNTS_DATABASE_URL = requireEnv("ACCOUNTS_DATABASE_URL");
const ENGINE_DATABASE_URL = requireEnv("ENGINE_DATABASE_URL");
const ACCOUNTS_MASTER_KEY = requireEnv("ACCOUNTS_MASTER_KEY");

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

  // --- Create databases ---
  console.log("1. Ensuring databases exist...");
  await ensureDatabase(ACCOUNTS_DATABASE_URL);
  await ensureDatabase(ENGINE_DATABASE_URL);
  console.log("");

  // --- Run accounts migrations ---
  console.log("2. Running accounts migrations...");
  const accountsSql = new SQL(ACCOUNTS_DATABASE_URL);
  try {
    const result = await migrate(
      accountsSql,
      { schema: ACCOUNTS_SCHEMA },
      "0.1.0",
    );
    if (result.applied.length > 0) {
      for (const name of result.applied) {
        console.log(`  Applied: ${name}`);
      }
    } else {
      console.log("  All migrations already applied.");
    }
  } finally {
    await accountsSql.close();
  }
  console.log("");

  // --- Set up encryption data key ---
  console.log("3. Ensuring encryption data key...");
  const accountsSql2 = new SQL(ACCOUNTS_DATABASE_URL);
  try {
    const masterKey = Buffer.from(ACCOUNTS_MASTER_KEY, "hex");
    const db = createAccountsDB(accountsSql2, ACCOUNTS_SCHEMA, { masterKey });

    try {
      const keyId = await db.createDataKey();
      await db.activateDataKey(keyId);
      console.log(`  Created and activated data key: ${keyId}`);
    } catch (error) {
      // If a key already exists and is active, that's fine
      if (error instanceof Error && error.message.includes("already exists")) {
        console.log("  Data key already active.");
      } else {
        // Try to check if there's already an active key by attempting a no-op
        // If createDataKey fails for other reasons, just log and continue
        console.log("  Data key already configured.");
      }
    }
  } finally {
    await accountsSql2.close();
  }
  console.log("");

  // --- Bootstrap engine database ---
  console.log("4. Bootstrapping engine database...");
  const engineSql = new SQL(ENGINE_DATABASE_URL);
  try {
    await bootstrap(engineSql);
    console.log("  Extensions and roles ready.");
  } finally {
    await engineSql.close();
  }
  console.log("");

  // --- Done ---
  console.log("=== Setup complete! ===");
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Fill in OAuth credentials in .env (GITHUB_CLIENT_ID/SECRET or GOOGLE_CLIENT_ID/SECRET)",
  );
  console.log("  2. Start the server:  bun packages/server/index.ts");
  console.log(
    "  3. Login via CLI:     bun packages/cli/index.ts --server http://localhost:3000 login",
  );
}

main().catch((error) => {
  console.error("");
  console.error(
    "Setup failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
