#!/usr/bin/env bun
import {
  bootstrapSpaceDatabase,
  CORE_SCHEMA_VERSION,
  migrateCore,
  migrateSpace,
  SPACE_SCHEMA_VERSION,
  slugToSchema,
} from "@memory.build/database";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/postgres";
const DEFAULT_SPACE_SLUG = "dev000000001";

type Mode = "all" | "core" | "space-db" | "space";

function usage(): string {
  return `Usage: ./bun run migrate:db [all|core|space-db|space]

Environment:
  DATABASE_URL       Postgres connection string. Falls back to ENGINE_DATABASE_URL, then ${DEFAULT_DATABASE_URL}
  SPACE_SLUG         Space slug to migrate. Defaults to ${DEFAULT_SPACE_SLUG}

Modes:
  all                Migrate core, prepare database for spaces, and migrate the dev space. Default.
  core               Migrate only the core schema.
  space-db           Prepare only the physical database for spaces.
  space              Prepare the database for spaces and migrate one space.
`;
}

function parseMode(arg: string | undefined): Mode {
  if (!arg) return "all";
  if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (
    arg === "all" ||
    arg === "core" ||
    arg === "space-db" ||
    arg === "space"
  ) {
    return arg;
  }
  console.error(`Invalid migration mode: ${arg}`);
  console.error(usage());
  process.exit(1);
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.ENGINE_DATABASE_URL ??
    DEFAULT_DATABASE_URL
  );
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv[2]);
  const url = databaseUrl();
  const spaceSlug = process.env.SPACE_SLUG ?? DEFAULT_SPACE_SLUG;
  const sql = postgres(url, { onnotice: () => {} });

  console.log(`Database: ${url}`);
  console.log(`Mode: ${mode}`);
  console.log(`Space slug: ${spaceSlug}`);
  console.log(`Core schema version: ${CORE_SCHEMA_VERSION}`);
  console.log(`Space schema version: ${SPACE_SCHEMA_VERSION}`);
  console.log("");

  try {
    if (mode === "all" || mode === "core") {
      await migrateCore(sql, { logSqlFiles: true });
      console.log("Migrated core.");
    }

    if (mode === "all" || mode === "space-db" || mode === "space") {
      await bootstrapSpaceDatabase(sql);
      console.log("Prepared database for spaces.");
    }

    if (mode === "all" || mode === "space") {
      await migrateSpace(sql, { slug: spaceSlug, logSqlFiles: true });
      console.log(`Migrated space ${slugToSchema(spaceSlug)}.`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("");
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error,
  );
  printErrorDetails(error);
  process.exit(1);
});

function printErrorDetails(error: unknown): void {
  if (!error || typeof error !== "object") return;

  const details = error as Record<string, unknown>;
  const keys = [
    "name",
    "errno",
    "code",
    "severity",
    "detail",
    "hint",
    "position",
    "internalPosition",
    "internalQuery",
    "where",
    "schema",
    "table",
    "column",
    "dataType",
    "constraint",
    "file",
    "line",
    "routine",
  ];
  const seen = new Set(keys);
  const extraKeys = [
    ...Object.getOwnPropertyNames(error),
    ...Object.keys(details),
  ].filter((key) => !seen.has(key) && key !== "message" && key !== "stack");

  const entries = [...keys, ...extraKeys]
    .map((key) => [key, details[key]] as const)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    );

  if (entries.length === 0) return;

  console.error("Postgres error details:");
  for (const [key, value] of entries) {
    console.error(`  ${key}: ${String(value)}`);
  }
}
