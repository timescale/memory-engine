import { createHash } from "node:crypto";
import { info, reportError, span } from "@pydantic/logfire-node";
import { semver } from "bun";
import type { ISql, Sql as SQL } from "postgres";
import { isValidSlug, slugToSchema } from "../slug";
import { SPACE_SCHEMA_VERSION } from "../version";
import incremental001 from "./incremental/001_memory.sql" with { type: "text" };
import incremental002 from "./incremental/002_embedding_queue.sql" with {
  type: "text",
};
import provisionSql from "./provision.sql" with { type: "text" };

interface Incremental {
  name: string;
  file: string;
  sql: string;
}

const incrementals: Incremental[] = [
  {
    name: "001_memory",
    file: "incremental/001_memory.sql",
    sql: incremental001,
  },
  {
    name: "002_embedding_queue",
    file: "incremental/002_embedding_queue.sql",
    sql: incremental002,
  },
];

import idempotent001 from "./idempotent/001_memory.sql" with { type: "text" };
import idempotent002 from "./idempotent/002_search.sql" with { type: "text" };
import idempotent003 from "./idempotent/003_embedding_queue.sql" with {
  type: "text",
};

interface Idempotent {
  name: string;
  file: string;
  sql: string;
}

const idempotents: Idempotent[] = [
  { name: "001_memory", file: "idempotent/001_memory.sql", sql: idempotent001 },
  { name: "002_search", file: "idempotent/002_search.sql", sql: idempotent002 },
  {
    name: "003_embedding_queue",
    file: "idempotent/003_embedding_queue.sql",
    sql: idempotent003,
  },
];

export interface MigrateSpaceOptions {
  slug: string;
  /**
   * Override the target schema name. Defaults to `slugToSchema(slug)` (the
   * production `me_<slug>`). Provided for tests, which provision under a
   * `metest_<slug>` prefix so leftovers are trivially distinguishable from real
   * spaces (see scripts/clean-test-schemas.ts). Must be a valid lowercase SQL
   * identifier; the slug is still validated and used for locking/telemetry.
   */
  schema?: string;
  logSqlFiles?: boolean;
  shardId?: number;
  embeddingDimensions?: number;
  bm25TextConfig?: string;
  bm25K1?: number;
  bm25B?: number;
  hnswM?: number;
  hnswEfConstruction?: number;
  statementTimeout?: string;
  lockTimeout?: string;
  transactionTimeout?: string;
  idleInTransactionSessionTimeout?: string;
}

interface NormalizedMigrateSpaceOptions {
  slug: string;
  schema?: string;
  logSqlFiles: boolean;
  schemaVersion: string;
  shardId?: number;
  embeddingDimensions: number;
  bm25TextConfig: string;
  bm25K1: number;
  bm25B: number;
  hnswM: number;
  hnswEfConstruction: number;
  statementTimeout: string;
  lockTimeout: string;
  transactionTimeout: string;
  idleInTransactionSessionTimeout: string;
}

export async function migrateSpace(
  sql: SQL,
  options: MigrateSpaceOptions,
): Promise<void> {
  const opts = normalizeMigrateSpaceOptions(options);
  const attributes = migrateAttributes(opts);

  await span("space.migrate", {
    attributes,
    callback: async () => {
      try {
        if (!isValidSlug(opts.slug)) {
          throw new Error(
            `Invalid space slug: "${opts.slug}" — must be 12 lowercase alphanumeric characters`,
          );
        }
        if (opts.schema !== undefined && !isValidSchemaName(opts.schema)) {
          throw new Error(
            `Invalid schema override: "${opts.schema}" — must be a valid lowercase SQL identifier (<= 63 chars)`,
          );
        }
        if (!semver.satisfies(opts.schemaVersion, "*")) {
          throw new Error(`Invalid schema version: "${opts.schemaVersion}"`);
        }
        const schema = opts.schema ?? slugToSchema(opts.slug);
        const schemaAttributes = { ...attributes, "db.schema": schema };
        const [key1, key2] = advisoryLockKey(`memory-space:schema:${schema}`);

        await sql.begin(async (tx) => {
          if (opts.shardId !== undefined) {
            if (!Number.isSafeInteger(opts.shardId)) {
              throw new Error(
                `shardId must be a safe integer, got: ${opts.shardId}`,
              );
            }
            await tx.unsafe(`set local pgdog.shard to ${String(opts.shardId)}`);
          }
          await tx`select set_config('statement_timeout', ${opts.statementTimeout}, true)`;
          await tx`select set_config('lock_timeout', ${opts.lockTimeout}, true)`;
          await tx`select set_config('transaction_timeout', ${opts.transactionTimeout}, true)`;
          await tx`select set_config('idle_in_transaction_session_timeout', ${opts.idleInTransactionSessionTimeout}, true)`;
          const acquired = await span("space.migrate.acquire_lock", {
            attributes: schemaAttributes,
            callback: () => acquireAdvisoryLock(tx, key1, key2),
          });
          if (!acquired) {
            throw new Error(
              `Unable to acquire lock for space slug ${opts.slug} migrations.`,
            );
          }

          if (!(await doesSpaceExist(tx, schema))) {
            await span("space.migrate.provision", {
              attributes: {
                ...schemaAttributes,
                "space.migration_file": "provision.sql",
                "space.migration_type": "provision",
              },
              callback: () => provisionSpace(tx, schema, opts),
            });
            info("Space schema provisioned", schemaAttributes);
          }
          await span("space.migrate.run", {
            attributes: schemaAttributes,
            callback: () => runMigrations(tx, schema, opts),
          });
        });
        info("Space migrations completed", schemaAttributes);
      } catch (error) {
        reportError("Space migration failed", error as Error, attributes);
        throw error;
      }
    },
  });
}

function migrateAttributes(
  options: NormalizedMigrateSpaceOptions,
): Record<string, unknown> {
  return {
    "space.slug": options.slug,
    "space.schema_version": options.schemaVersion,
    "db.shard": options.shardId,
    "db.statement_timeout": options.statementTimeout,
    "db.lock_timeout": options.lockTimeout,
    "db.transaction_timeout": options.transactionTimeout,
    "db.idle_in_transaction_session_timeout":
      options.idleInTransactionSessionTimeout,
  };
}

function normalizeMigrateSpaceOptions(
  options: MigrateSpaceOptions,
): NormalizedMigrateSpaceOptions {
  return {
    slug: options.slug,
    schema: options.schema,
    logSqlFiles: options.logSqlFiles ?? false,
    schemaVersion: SPACE_SCHEMA_VERSION,
    shardId: options.shardId,
    embeddingDimensions: options.embeddingDimensions ?? 1536,
    bm25TextConfig: options.bm25TextConfig ?? "english",
    bm25K1: options.bm25K1 ?? 1.2,
    bm25B: options.bm25B ?? 0.75,
    hnswM: options.hnswM ?? 16,
    hnswEfConstruction: options.hnswEfConstruction ?? 64,
    statementTimeout: options.statementTimeout ?? "20s",
    lockTimeout: options.lockTimeout ?? "5s",
    transactionTimeout: options.transactionTimeout ?? "1min",
    idleInTransactionSessionTimeout:
      options.idleInTransactionSessionTimeout ?? "5s",
  };
}

function templateVars(
  schema: string,
  options: NormalizedMigrateSpaceOptions,
): Record<string, unknown> {
  return {
    ...options,
    schema,
    embedding_dimensions: options.embeddingDimensions,
    bm25_text_config: options.bm25TextConfig,
    bm25_k1: options.bm25K1,
    bm25_b: options.bm25B,
    hnsw_m: options.hnswM,
    hnsw_ef_construction: options.hnswEfConstruction,
  };
}

function isValidSchemaName(schema: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(schema) && schema.length <= 63;
}

function advisoryLockKey(schema: string): [number, number] {
  const digest = createHash("sha256").update(schema).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

const MAX_LOCK_RETRIES = 5;
const BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireAdvisoryLock(
  tx: ISql,
  key1: number,
  key2: number,
): Promise<boolean> {
  let acquired = false;
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
    const [result] = await tx`
      select pg_try_advisory_xact_lock(${key1}, ${key2}) as acquired
    `;
    if (result?.acquired) {
      acquired = true;
      break;
    }
    if (attempt < MAX_LOCK_RETRIES - 1) {
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }
  return acquired;
}

async function doesSpaceExist(tx: ISql, schema: string): Promise<boolean> {
  const [row] = await tx`
    select exists
    (
      select 1
      from pg_namespace n
      where n.nspname = ${schema}
    ) as "spaceExists"
    `;
  return Boolean(row?.spaceExists);
}

async function provisionSpace(
  tx: ISql,
  schema: string,
  options: NormalizedMigrateSpaceOptions,
): Promise<void> {
  await executeSqlFile(
    tx,
    options,
    schema,
    "provision",
    "provision.sql",
    template(provisionSql, { schema }),
  );
}

async function runMigrations(
  tx: ISql,
  schema: string,
  options: NormalizedMigrateSpaceOptions,
): Promise<void> {
  // check ownership
  await assertSchemaOwnership(tx, schema);

  // check version
  const [versionRow] = await tx`
    select version from ${tx(schema)}.version
  `;
  const dbVersion: string = versionRow?.version;
  const cmp = semver.order(options.schemaVersion, dbVersion);
  // abort if target is older than the database
  if (cmp < 0) {
    throw new Error(
      `Application version (${options.schemaVersion}) is older than database version (${dbVersion}). ` +
        "Please upgrade the application.",
    );
  }
  /* run migrations regardless
  if (cmp === 0) {
    // version matches. no need to run migrations
    info("Space migration skipped, version current", {
      "db.schema": schema,
      "space.version": dbVersion,
      "space.schema_version": options.schemaVersion,
    });
    return;
  }
  */

  // run incremental migrations
  const sorted1 = [...incrementals].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const migration of sorted1) {
    const [existingRow] = await tx`
      select exists
      (
        select 1
        from ${tx(schema)}.migration
        where name = ${migration.name}
      ) as existing
      `;

    if (existingRow?.existing) {
      continue;
    }

    await span("space.migrate.incremental", {
      attributes: {
        "db.schema": schema,
        "space.migration": migration.name,
        "space.migration_file": migration.file,
        "space.migration_type": "incremental",
        "space.schema_version": options.schemaVersion,
      },
      callback: async () => {
        const renderedSql = template(
          migration.sql,
          templateVars(schema, options),
        );
        await executeSqlFile(
          tx,
          options,
          schema,
          "incremental",
          migration.file,
          renderedSql,
        );
        await tx`
          insert into ${tx(schema)}.migration (name, applied_at_version)
          values (${migration.name}, ${options.schemaVersion})`;
      },
    });
    info("Space migration applied", {
      "db.schema": schema,
      "space.migration": migration.name,
      "space.migration_file": migration.file,
      "space.migration_type": "incremental",
      "space.schema_version": options.schemaVersion,
    });
  }

  // run idempotent migrations
  const sorted2 = [...idempotents].sort((a, b) => a.name.localeCompare(b.name));

  for (const migration of sorted2) {
    await span("space.migrate.idempotent", {
      attributes: {
        "db.schema": schema,
        "space.migration": migration.name,
        "space.migration_file": migration.file,
        "space.migration_type": "idempotent",
        "space.schema_version": options.schemaVersion,
      },
      callback: async () => {
        const renderedSql = template(
          migration.sql,
          templateVars(schema, options),
        );
        await executeSqlFile(
          tx,
          options,
          schema,
          "idempotent",
          migration.file,
          renderedSql,
        );
      },
    });
  }

  // update version
  await tx`update ${tx(schema)}.version set version = ${options.schemaVersion}, at = now()`;
}

async function executeSqlFile(
  tx: ISql,
  options: NormalizedMigrateSpaceOptions,
  schema: string,
  type: string,
  file: string,
  sqlText: string,
): Promise<void> {
  logSqlFile(options, schema, type, file);
  try {
    await tx.unsafe(sqlText);
  } catch (error) {
    logSqlExecutionError(options, schema, type, file, sqlText, error);
    throw error;
  }
}

function logSqlFile(
  options: NormalizedMigrateSpaceOptions,
  schema: string,
  type: string,
  file: string,
): void {
  if (!options.logSqlFiles) return;
  console.error(
    `[migrate:db] space ${schema} ${type} packages/space/migrate/${file}`,
  );
}

function logSqlExecutionError(
  options: NormalizedMigrateSpaceOptions,
  schema: string,
  type: string,
  file: string,
  sqlText: string,
  error: unknown,
): void {
  if (!options.logSqlFiles) return;
  console.error(
    `[migrate:db] failed space ${schema} ${type} packages/space/migrate/${file}`,
  );
  logPostgresSqlLocation(sqlText, error);
}

function logPostgresSqlLocation(sqlText: string, error: unknown): void {
  // postgres-js sets `position` (1-based) on server errors; non-PG errors won't.
  const position = Number((error as { position?: unknown })?.position);
  if (!Number.isSafeInteger(position) || position < 1) return;

  const location = sqlLocation(sqlText, position);
  if (!location) return;
  console.error(
    `[migrate:db] sql position ${position} -> line ${location.line}, column ${location.column}`,
  );
  console.error(sqlContext(sqlText, location.line, location.column));
}

function sqlLocation(
  sqlText: string,
  position: number,
): { line: number; column: number } | undefined {
  if (position > sqlText.length + 1) return undefined;
  let line = 1;
  let column = 1;
  for (let i = 0; i < position - 1; i++) {
    if (sqlText.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function sqlContext(sqlText: string, line: number, column: number): string {
  const lines = sqlText.split("\n");
  const start = Math.max(1, line - 2);
  const end = Math.min(lines.length, line + 2);
  const width = String(end).length;
  const output = ["[migrate:db] sql context:"];

  for (let n = start; n <= end; n++) {
    const marker = n === line ? ">" : " ";
    output.push(`${marker} ${String(n).padStart(width)} | ${lines[n - 1]}`);
    if (n === line) {
      output.push(`  ${" ".repeat(width)} | ${" ".repeat(column - 1)}^`);
    }
  }

  return output.join("\n");
}

async function assertSchemaOwnership(tx: ISql, schema: string): Promise<void> {
  const [result] = await tx`
    select
      n.nspowner = (select pg_catalog.to_regrole(current_user)::oid) as is_owner
    from pg_catalog.pg_namespace n
    where n.nspname = ${schema}
  `;

  if (!result?.is_owner) {
    throw new Error(
      `Only the owner of the ${schema} schema can run database migrations`,
    );
  }
}

function template(sql: string, vars: Record<string, unknown>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(vars[key]);
  });
}
