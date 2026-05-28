import { createHash } from "node:crypto";
import { info, reportError, span } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import { semver } from "bun";
import { isValidSlug, slugToSchema } from "../slug";
import { SPACE_SCHEMA_VERSION } from "../version";

import provisionSql from "./incremental/000_provision.sql" with {
  type: "text",
};
import incremental001 from "./incremental/001_memory.sql" with { type: "text" };
import incremental002 from "./incremental/002_embedding_queue.sql" with {
  type: "text",
};

interface Incremental {
  name: string;
  sql: string;
}

const incrementals: Incremental[] = [
  { name: "001_memory", sql: incremental001 },
  { name: "002_embedding_queue", sql: incremental002 },
];

import idempotent001 from "./idempotent/001_memory.sql" with { type: "text" };
import idempotent002 from "./idempotent/002_search.sql" with { type: "text" };
import idempotent003 from "./idempotent/003_embedding_queue.sql" with {
  type: "text",
};

interface Idempotent {
  name: string;
  sql: string;
}

const idempotents: Idempotent[] = [
  { name: "001_memory", sql: idempotent001 },
  { name: "002_search", sql: idempotent002 },
  { name: "003_embedding_queue", sql: idempotent003 },
];

export interface MigrateSpaceOptions {
  slug: string;
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
        if (!semver.satisfies(opts.schemaVersion, "*")) {
          throw new Error(`Invalid schema version: "${opts.schemaVersion}"`);
        }
        const schema = slugToSchema(opts.slug);
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
              attributes: schemaAttributes,
              callback: () => provisionSpace(tx, schema),
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
  tx: SQL,
  key1: number,
  key2: number,
): Promise<boolean> {
  let acquired = false;
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
    const [result] = await tx`
      select pg_try_advisory_xact_lock(${key1}, ${key2}) as acquired
    `;
    if (result.acquired) {
      acquired = true;
      break;
    }
    if (attempt < MAX_LOCK_RETRIES - 1) {
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }
  return acquired;
}

async function doesSpaceExist(tx: SQL, schema: string): Promise<boolean> {
  const [{ spaceExists }] = await tx`
    select exists
    (
      select 1
      from pg_namespace n
      where n.nspname = ${schema}
    ) as "spaceExists"
    `;
  return spaceExists;
}

async function provisionSpace(tx: SQL, schema: string): Promise<void> {
  await tx.unsafe(template(provisionSql, { schema }));
}

async function runMigrations(
  tx: SQL,
  schema: string,
  options: NormalizedMigrateSpaceOptions,
): Promise<void> {
  // check ownership
  await assertSchemaOwnership(tx, schema);

  // check version
  const [{ version: dbVersion }] = await tx`
    select version from ${tx(schema)}.version
  `;
  const cmp = semver.order(options.schemaVersion, dbVersion);
  // abort if target is older than the database
  if (cmp < 0) {
    throw new Error(
      `Schema version (${options.schemaVersion}) is older than database version (${dbVersion}). ` +
        "Please upgrade the server.",
    );
  }
  if (cmp === 0) {
    // version matches. no need to run migrations
    info("Space migration skipped, version current", {
      "db.schema": schema,
      "space.version": dbVersion,
      "space.schema_version": options.schemaVersion,
    });
    return;
  }

  // run incremental migrations
  const sorted1 = [...incrementals].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const migration of sorted1) {
    const [{ existing }] = await tx`
      select exists
      (
        select 1
        from ${tx(schema)}.migration
        where name = ${migration.name}
      ) as existing
      `;

    if (existing) {
      continue;
    }

    await span("space.migrate.incremental", {
      attributes: {
        "db.schema": schema,
        "space.migration": migration.name,
        "space.migration_type": "incremental",
        "space.schema_version": options.schemaVersion,
      },
      callback: async () => {
        const renderedSql = template(
          migration.sql,
          templateVars(schema, options),
        );
        await tx.unsafe(renderedSql);
        await tx`
          insert into ${tx(schema)}.migration (name, applied_at_version)
          values (${migration.name}, ${options.schemaVersion})`;
      },
    });
    info("Space migration applied", {
      "db.schema": schema,
      "space.migration": migration.name,
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
        "space.migration_type": "idempotent",
        "space.schema_version": options.schemaVersion,
      },
      callback: async () => {
        const renderedSql = template(
          migration.sql,
          templateVars(schema, options),
        );
        await tx.unsafe(renderedSql);
      },
    });
  }

  // update version
  await tx`update ${tx(schema)}.version set version = ${options.schemaVersion}, at = now()`;
}

async function assertSchemaOwnership(tx: SQL, schema: string): Promise<void> {
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
