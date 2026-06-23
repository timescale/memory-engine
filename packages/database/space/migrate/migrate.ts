import { info, reportError, span } from "@pydantic/logfire-node";
import { semver } from "bun";
import type { ISql, Sql as SQL } from "postgres";
import {
  acquireAdvisoryLock,
  advisoryLockKey,
  applySessionTimeouts,
  doesSchemaExist,
  executeSqlFile,
  isValidSchemaName,
  type Migration,
  runSchemaMigrations,
  template,
} from "../../migrate/kit";
import { isValidSlug, slugToSchema } from "../slug";
import { SPACE_SCHEMA_VERSION } from "../version";
import idempotent001 from "./idempotent/001_memory.sql" with { type: "text" };
import idempotent002 from "./idempotent/002_search.sql" with { type: "text" };
import idempotent003 from "./idempotent/003_embedding_queue.sql" with {
  type: "text",
};
import incremental001 from "./incremental/001_memory.sql" with { type: "text" };
import incremental002 from "./incremental/002_embedding_queue.sql" with {
  type: "text",
};
import incremental003 from "./incremental/003_embedding_fk_idx.sql" with {
  type: "text",
};
import incremental004 from "./incremental/004_count_tree.sql" with {
  type: "text",
};
import incremental005 from "./incremental/005_memory_name.sql" with {
  type: "text",
};
import incremental006 from "./incremental/006_content_version.sql" with {
  type: "text",
};
import incremental007 from "./incremental/007_memory_version.sql" with {
  type: "text",
};
import provisionSql from "./provision.sql" with { type: "text" };

const DIR = "packages/database/space/migrate";

const incrementals: Migration[] = [
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
  {
    name: "003_embedding_fk_idx",
    file: "incremental/003_embedding_fk_idx.sql",
    sql: incremental003,
  },
  {
    name: "004_count_tree",
    file: "incremental/004_count_tree.sql",
    sql: incremental004,
  },
  {
    name: "005_memory_name",
    file: "incremental/005_memory_name.sql",
    sql: incremental005,
  },
  {
    name: "006_content_version",
    file: "incremental/006_content_version.sql",
    sql: incremental006,
  },
  {
    name: "007_memory_version",
    file: "incremental/007_memory_version.sql",
    sql: incremental007,
  },
];

const idempotents: Migration[] = [
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

/** Validate options and resolve the target schema name. */
function resolveSchema(opts: NormalizedMigrateSpaceOptions): string {
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
  return opts.schema ?? slugToSchema(opts.slug);
}

/** Provision (if missing) then run all migrations, against a given transaction. */
async function provisionAndRun(
  tx: ISql,
  schema: string,
  opts: NormalizedMigrateSpaceOptions,
): Promise<void> {
  if (!(await doesSchemaExist(tx, schema))) {
    await executeSqlFile(tx, template(provisionSql, { schema }), {
      logSqlFiles: opts.logSqlFiles,
      label: "space",
      schema,
      type: "provision",
      dir: DIR,
      file: "provision.sql",
    });
  }
  await runSchemaMigrations(tx, {
    schema,
    schemaVersion: opts.schemaVersion,
    incrementals,
    idempotents,
    templateVars: templateVars(schema, opts),
    label: "space",
    dir: DIR,
    logSqlFiles: opts.logSqlFiles,
  });
}

/**
 * Provision + migrate a space schema within the CALLER's transaction — no own
 * transaction and no advisory lock. Because schema creation is transactional,
 * the caller can compose this atomically with other writes (e.g. provisionUser
 * creates the me_<slug> schema + the core/auth rows in one transaction, so any
 * failure rolls the schema back — no orphan, no cleanup).
 *
 * Use `migrateSpace` for the standalone re-migrate path: it owns its
 * transaction + advisory lock to serialize concurrent migrators of an existing
 * space. Skipping the lock here is safe — a freshly generated slug has no
 * contender, and the schema-name / `space.slug` uniqueness makes any race
 * fail-and-roll-back.
 */
export async function provisionSpace(
  tx: ISql,
  options: MigrateSpaceOptions,
): Promise<void> {
  const opts = normalizeMigrateSpaceOptions(options);
  const schema = resolveSchema(opts);
  await provisionAndRun(tx, schema, opts);
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
        const schema = resolveSchema(opts);
        const schemaAttributes = { ...attributes, "db.schema": schema };
        const [key1, key2] = advisoryLockKey(`memory-space:schema:${schema}`);

        await sql.begin(async (tx) => {
          await applySessionTimeouts(tx, opts);
          const acquired = await span("space.migrate.acquire_lock", {
            attributes: schemaAttributes,
            callback: () => acquireAdvisoryLock(tx, key1, key2),
          });
          if (!acquired) {
            throw new Error(
              `Unable to acquire lock for space slug ${opts.slug} migrations.`,
            );
          }
          await provisionAndRun(tx, schema, opts);
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
