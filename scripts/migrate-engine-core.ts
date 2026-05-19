#!/usr/bin/env bun

import { SQL } from "bun";
import { bootstrapEngineDatabase } from "../packages/engine-core/migrate/bootstrap";
import { migrateEngine } from "../packages/engine-core/migrate/migrate";
import { slugToSchema } from "../packages/engine-core/slug";

const ENGINE_SLUG = "dev000000001";
const TARGET_VERSION = process.env.TARGET_VERSION ?? "0.1.0";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.ENGINE_DATABASE_URL ??
  "postgresql://postgres@localhost:5432/postgres";

const sql = new SQL(DATABASE_URL);

try {
  console.log(
    `Bootstrapping engine database and migrating ${slugToSchema(ENGINE_SLUG)} to ${TARGET_VERSION}`,
  );
  await bootstrapEngineDatabase(sql);
  await migrateEngine(sql, {
    slug: ENGINE_SLUG,
    targetVersion: TARGET_VERSION,
  });
  console.log(`Engine schema ${slugToSchema(ENGINE_SLUG)} is up to date.`);
} finally {
  await sql.close();
}
