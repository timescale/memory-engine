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

  // Create schema
  await sql.unsafe(`create schema if not exists ${schema}`);

  // Grant usage to all roles before running migrations
  await sql.unsafe(`grant usage on schema ${schema} to me_ro, me_rw, me_embed`);

  // Run migrations
  const migrateResult = await migrateEngine(sql, schema, config, appVersion);

  return { schema, migrateResult };
}
