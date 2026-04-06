import type { SQL } from "bun";

import { isValidSlug, slugToSchema } from "./discover";
import { type MigrateResult, migrateEngine } from "./runner";
import type { EngineConfig } from "./template";

export interface ProvisionResult {
  schema: string;
  migrateResult: MigrateResult;
}

export async function provisionEngine(
  sql: SQL,
  slug: string,
  config: EngineConfig | undefined,
  appVersion: string,
): Promise<ProvisionResult> {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid engine slug: "${slug}" — must be 12 lowercase alphanumeric characters`,
    );
  }

  const schema = slugToSchema(slug);

  // Transaction 1: Create schema infrastructure (all or nothing)
  await sql.begin(async (tx) => {
    // Create schema (fails if exists - use migrateEngine for existing schemas)
    await tx.unsafe(`create schema ${schema}`);

    // Version tracking table (single row)
    await tx.unsafe(`
      create table ${schema}.version
      ( version text not null check (version ~ '^\\d+\\.\\d+\\.\\d+$')
      , at timestamptz not null default now()
      )
    `);
    await tx.unsafe(`create unique index on ${schema}.version ((true))`);
    await tx.unsafe(`insert into ${schema}.version (version) values ('0.0.0')`);

    // Grant usage to all roles
    await tx.unsafe(
      `grant usage on schema ${schema} to me_ro, me_rw, me_embed`,
    );
  });

  // Transaction 2: Run migrations
  const migrateResult = await migrateEngine(sql, schema, config, appVersion);

  return { schema, migrateResult };
}
