import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { semver } from "bun";
import { isValidSlug, slugToSchema } from "../slug";

import incremental001 from "./incremental/001_user.sql" with { type: "text" };
import incremental002 from "./incremental/002_role_membership.sql" with {
  type: "text",
};
import incremental003 from "./incremental/003_tree_ownership.sql" with {
  type: "text",
};
import incremental004 from "./incremental/004_tree_grant.sql" with {
  type: "text",
};
import incremental005 from "./incremental/005_memory.sql" with { type: "text" };
import incremental006 from "./incremental/006_embedding_queue.sql" with {
  type: "text",
};

interface Incremental {
  name: string;
  sql: string;
}

const incrementals: Incremental[] = [
  { name: "001_user", sql: incremental001 },
  { name: "002_role_membership", sql: incremental002 },
  { name: "003_tree_ownership", sql: incremental003 },
  { name: "004_tree_grant", sql: incremental004 },
  { name: "005_memory", sql: incremental005 },
  { name: "006_embedding_queue", sql: incremental006 },
];

import idempotent001 from "./idempotent/001_role_membership.sql" with {
  type: "text",
};
import idempotent002 from "./idempotent/002_tree_privileges.sql" with {
  type: "text",
};
import idempotent003 from "./idempotent/003_memory.sql" with { type: "text" };
import idempotent004 from "./idempotent/004_embedding_queue.sql" with {
  type: "text",
};

interface Idempotent {
  name: string;
  sql: string;
}

const idempotents: Idempotent[] = [
  { name: "001_role_membership", sql: idempotent001 },
  { name: "002_tree_privileges", sql: idempotent002 },
  { name: "003_memory", sql: idempotent003 },
  { name: "004_embedding_queue", sql: idempotent004 },
];

export interface MigrateEngineOptions {
  slug: string;
  targetVersion: string;
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

interface NormalizedMigrateEngineOptions {
  slug: string;
  targetVersion: string;
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

export async function migrateEngine(
  sql: SQL,
  options: MigrateEngineOptions,
): Promise<void> {
  const opts = normalizeMigrateEngineOptions(options);

  if (!isValidSlug(opts.slug)) {
    throw new Error(
      `Invalid engine slug: "${opts.slug}" — must be 12 lowercase alphanumeric characters`,
    );
  }
  if (!semver.satisfies(opts.targetVersion, "*")) {
    throw new Error(`Invalid target version: "${opts.targetVersion}"`);
  }
  const schema = slugToSchema(opts.slug);
  const [key1, key2] = advisoryLockKey(`memory-engine:schema:${schema}`);

  await sql.begin(async (tx) => {
    if (opts.shardId !== undefined) {
      if (!Number.isSafeInteger(opts.shardId)) {
        throw new Error(`shardId must be a safe integer, got: ${opts.shardId}`);
      }
      await tx.unsafe(`set local pgdog.shard to ${String(opts.shardId)}`);
    }
    await tx`select set_config('statement_timeout', ${opts.statementTimeout}, true)`;
    await tx`select set_config('lock_timeout', ${opts.lockTimeout}, true)`;
    await tx`select set_config('transaction_timeout', ${opts.transactionTimeout}, true)`;
    await tx`select set_config('idle_in_transaction_session_timeout', ${opts.idleInTransactionSessionTimeout}, true)`;
    if (!(await acquireAdvisoryLock(tx, key1, key2))) {
      throw new Error(
        `Unable to acquire lock for engine slug ${opts.slug} migrations.`,
      );
    }

    if (!(await doesEngineExist(tx, schema))) {
      await provisionEngine(tx, schema);
    }
    await runMigrations(tx, schema, opts);
  });
}

function normalizeMigrateEngineOptions(
  options: MigrateEngineOptions,
): NormalizedMigrateEngineOptions {
  return {
    slug: options.slug,
    targetVersion: options.targetVersion,
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
  options: NormalizedMigrateEngineOptions,
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

async function doesEngineExist(tx: SQL, schema: string): Promise<boolean> {
  const [{ engineExists }] = await tx`
    select exists
    (
      select 1
      from pg_namespace n
      where n.nspname = ${schema}
    ) as "engineExists"
    `;
  return engineExists;
}

async function provisionEngine(tx: SQL, schema: string): Promise<void> {
  await tx`create schema ${tx(schema)}`;

  // grant usage to all roles
  await tx`grant usage on schema ${tx(schema)} to me_ro, me_rw, me_embed`;

  // version tracking table (single row)
  await tx`
    create table ${tx(schema)}.version
    ( version text not null
    , at timestamptz not null default now()
    )
  `;
  await tx`create unique index version_singleton_idx on ${tx(schema)}.version ((true))`; // only allow one row
  await tx`insert into ${tx(schema)}.version (version) values ('0.0.0')`;

  // migration tracking table
  await tx`
    create table ${tx(schema)}.migration
    ( name text not null constraint migration_pkey primary key
    , applied_at_version text not null
    , applied_at timestamptz not null default pg_catalog.clock_timestamp()
    )
  `;
}

async function runMigrations(
  tx: SQL,
  schema: string,
  options: NormalizedMigrateEngineOptions,
): Promise<void> {
  // check ownership
  await assertSchemaOwnership(tx, schema);

  // check version
  const [{ version: dbVersion }] = await tx`
    select version from ${tx(schema)}.version
  `;
  const cmp = semver.order(options.targetVersion, dbVersion);
  // abort if target is older than the database
  if (cmp < 0) {
    throw new Error(
      `Target version (${options.targetVersion}) is older than database version (${dbVersion}). ` +
        "Please upgrade the server.",
    );
  }
  if (cmp === 0) {
    // version matches. no need to run migrations
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

    const renderedSql = template(migration.sql, templateVars(schema, options));
    await tx.unsafe(renderedSql);
    await tx`
      insert into ${tx(schema)}.migration (name, applied_at_version)
      values (${migration.name}, ${options.targetVersion})`;
  }

  // run idempotent migrations
  const sorted2 = [...idempotents].sort((a, b) => a.name.localeCompare(b.name));

  for (const migration of sorted2) {
    const renderedSql = template(migration.sql, templateVars(schema, options));
    await tx.unsafe(renderedSql);
  }

  // update version
  await tx`update ${tx(schema)}.version set version = ${options.targetVersion}, at = now()`;
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
