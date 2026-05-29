import { createHash } from "node:crypto";
import { info, reportError, span } from "@pydantic/logfire-node";
import { SQL, semver } from "bun";
import { CORE_SCHEMA_VERSION } from "../version";
import incremental001 from "./incremental/001_shard.sql" with { type: "text" };
import incremental002 from "./incremental/002_space.sql" with { type: "text" };
import incremental003 from "./incremental/003_principal.sql" with {
  type: "text",
};
import incremental004 from "./incremental/004_principal_space.sql" with {
  type: "text",
};
import incremental005 from "./incremental/005_group_member.sql" with {
  type: "text",
};
import incremental006 from "./incremental/006_tree_access.sql" with {
  type: "text",
};
import incremental007 from "./incremental/007_api_key.sql" with {
  type: "text",
};
import provisionSql from "./provision.sql" with { type: "text" };

interface Incremental {
  name: string;
  file: string;
  sql: string;
}

const incrementals: Incremental[] = [
  { name: "001_shard", file: "incremental/001_shard.sql", sql: incremental001 },
  { name: "002_space", file: "incremental/002_space.sql", sql: incremental002 },
  {
    name: "003_principal",
    file: "incremental/003_principal.sql",
    sql: incremental003,
  },
  {
    name: "004_principal_space",
    file: "incremental/004_principal_space.sql",
    sql: incremental004,
  },
  {
    name: "005_group_member",
    file: "incremental/005_group_member.sql",
    sql: incremental005,
  },
  {
    name: "006_tree_access",
    file: "incremental/006_tree_access.sql",
    sql: incremental006,
  },
  {
    name: "007_api_key",
    file: "incremental/007_api_key.sql",
    sql: incremental007,
  },
];

import idempotent000 from "./idempotent/000_update.sql" with { type: "text" };
import idempotent001 from "./idempotent/001_principal_space.sql" with {
  type: "text",
};
import idempotent002 from "./idempotent/002_group_member.sql" with {
  type: "text",
};
import idempotent003 from "./idempotent/003_tree_access.sql" with {
  type: "text",
};

interface Idempotent {
  name: string;
  file: string;
  sql: string;
}

const idempotents: Idempotent[] = [
  { name: "000_update", file: "idempotent/000_update.sql", sql: idempotent000 },
  {
    name: "001_principal_space",
    file: "idempotent/001_principal_space.sql",
    sql: idempotent001,
  },
  {
    name: "002_group_member",
    file: "idempotent/002_group_member.sql",
    sql: idempotent002,
  },
  {
    name: "003_tree_access",
    file: "idempotent/003_tree_access.sql",
    sql: idempotent003,
  },
];

const CORE_SCHEMA = "core";
const REQUIRED_EXTENSIONS = [
  { name: "citext", minVersion: "1.6" },
  { name: "ltree", minVersion: "1.3" },
  { name: "vector", minVersion: "0.8.2" },
  { name: "pg_textsearch", minVersion: "1.1.0" },
] as const;

export interface MigrateCoreOptions {
  logSqlFiles?: boolean;
  statementTimeout?: string;
  lockTimeout?: string;
  transactionTimeout?: string;
  idleInTransactionSessionTimeout?: string;
}

interface NormalizedMigrateCoreOptions {
  logSqlFiles: boolean;
  schemaVersion: string;
  statementTimeout: string;
  lockTimeout: string;
  transactionTimeout: string;
  idleInTransactionSessionTimeout: string;
}

export async function migrateCore(
  sql: SQL,
  options: MigrateCoreOptions = {},
): Promise<void> {
  const opts = normalizeMigrateCoreOptions(options);
  const attributes = migrateAttributes(opts);

  await span("core.migrate", {
    attributes,
    callback: async () => {
      try {
        if (!semver.satisfies(opts.schemaVersion, "*")) {
          throw new Error(`Invalid schema version: "${opts.schemaVersion}"`);
        }
        const [key1, key2] = advisoryLockKey("memory-core:schema:core");

        await sql.begin(async (tx) => {
          await tx`select set_config('statement_timeout', ${opts.statementTimeout}, true)`;
          await tx`select set_config('lock_timeout', ${opts.lockTimeout}, true)`;
          await tx`select set_config('transaction_timeout', ${opts.transactionTimeout}, true)`;
          await tx`select set_config('idle_in_transaction_session_timeout', ${opts.idleInTransactionSessionTimeout}, true)`;
          const acquired = await span("core.migrate.acquire_lock", {
            attributes,
            callback: () => acquireAdvisoryLock(tx, key1, key2),
          });
          if (!acquired) {
            throw new Error("Unable to acquire lock for core migrations.");
          }

          await ensurePostgresVersion(tx);
          for (const extension of REQUIRED_EXTENSIONS) {
            await span("core.migrate.ensure_extension", {
              attributes: {
                "db.extension": extension.name,
                "db.extension_min_version": extension.minVersion,
              },
              callback: () =>
                ensureExtension(tx, extension.name, extension.minVersion),
            });
          }

          if (!(await doesCoreExist(tx))) {
            await span("core.migrate.provision", {
              attributes: {
                ...attributes,
                "core.migration_file": "provision.sql",
                "core.migration_type": "provision",
              },
              callback: () => provisionCore(tx, opts),
            });
            info("Core schema provisioned", attributes);
          }
          await span("core.migrate.run", {
            attributes,
            callback: () => runMigrations(tx, opts),
          });
        });
        info("Core migrations completed", attributes);
      } catch (error) {
        reportError("Core migration failed", error as Error, attributes);
        throw error;
      }
    },
  });
}

function migrateAttributes(
  options: NormalizedMigrateCoreOptions,
): Record<string, unknown> {
  return {
    "db.schema": CORE_SCHEMA,
    "core.schema_version": options.schemaVersion,
    "core.required_extensions": REQUIRED_EXTENSIONS.map(
      (extension) => `${extension.name}@>=${extension.minVersion}`,
    ),
    "db.statement_timeout": options.statementTimeout,
    "db.lock_timeout": options.lockTimeout,
    "db.transaction_timeout": options.transactionTimeout,
    "db.idle_in_transaction_session_timeout":
      options.idleInTransactionSessionTimeout,
  };
}

function normalizeMigrateCoreOptions(
  options: MigrateCoreOptions,
): NormalizedMigrateCoreOptions {
  return {
    logSqlFiles: options.logSqlFiles ?? false,
    schemaVersion: CORE_SCHEMA_VERSION,
    statementTimeout: options.statementTimeout ?? "20s",
    lockTimeout: options.lockTimeout ?? "5s",
    transactionTimeout: options.transactionTimeout ?? "1min",
    idleInTransactionSessionTimeout:
      options.idleInTransactionSessionTimeout ?? "5s",
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

async function doesCoreExist(tx: SQL): Promise<boolean> {
  const [{ coreExists }] = await tx`
    select exists
    (
      select 1
      from pg_namespace n
      where n.nspname = ${CORE_SCHEMA}
    ) as "coreExists"
    `;
  return coreExists;
}

async function provisionCore(
  tx: SQL,
  options: NormalizedMigrateCoreOptions,
): Promise<void> {
  await executeSqlFile(tx, options, "provision", "provision.sql", provisionSql);
}

async function ensurePostgresVersion(tx: SQL): Promise<void> {
  const [{ server_version_num }] = await tx`
    select current_setting('server_version_num')::int as server_version_num
  `;
  if (server_version_num < 180000) {
    throw new Error(
      `PostgreSQL version 18 or higher is required (found ${server_version_num})`,
    );
  }
}

async function ensureExtension(
  tx: SQL,
  name: string,
  minVersion: string,
): Promise<void> {
  const [installed] = await tx`
    select x.extversion, n.nspname
    from pg_extension x
    inner join pg_namespace n on (x.extnamespace = n.oid)
    where x.extname = ${name}
  `;

  if (installed) {
    if (
      installed.nspname === "public" &&
      semver.order(installed.extversion, minVersion) >= 0
    ) {
      return;
    }
    throw new Error(
      `Extension "${name}" version ${minVersion} or higher is required in the "public" schema (found ${installed.extversion} installed in "${installed.nspname}")`,
    );
  }

  const [available] = await tx`
    select default_version
    from pg_available_extensions
    where name = ${name}
  `;

  if (!available || semver.order(available.default_version, minVersion) < 0) {
    const found = available
      ? `found ${available.default_version} available`
      : "not available";
    throw new Error(
      `Extension "${name}" version ${minVersion} or higher is required (${found})`,
    );
  }

  await tx`create extension if not exists ${tx(name)} with schema public`;
}

async function runMigrations(
  tx: SQL,
  options: NormalizedMigrateCoreOptions,
): Promise<void> {
  await assertSchemaOwnership(tx);

  const [{ version: dbVersion }] = await tx`
    select version from core.version
  `;
  const cmp = semver.order(options.schemaVersion, dbVersion);
  if (cmp < 0) {
    throw new Error(
      `Schema version (${options.schemaVersion}) is older than database version (${dbVersion}). ` +
        "Please upgrade the server.",
    );
  }
  if (cmp === 0) {
    info("Core migration skipped, version current", {
      "db.schema": CORE_SCHEMA,
      "core.version": dbVersion,
      "core.schema_version": options.schemaVersion,
    });
    return;
  }

  const sorted1 = [...incrementals].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const migration of sorted1) {
    const [{ existing }] = await tx`
      select exists
      (
        select 1
        from core.migration
        where name = ${migration.name}
      ) as existing
      `;

    if (existing) {
      continue;
    }

    await span("core.migrate.incremental", {
      attributes: {
        "db.schema": CORE_SCHEMA,
        "core.migration": migration.name,
        "core.migration_file": migration.file,
        "core.migration_type": "incremental",
        "core.schema_version": options.schemaVersion,
      },
      callback: async () => {
        await executeSqlFile(
          tx,
          options,
          "incremental",
          migration.file,
          migration.sql,
        );
        await tx`
          insert into core.migration (name, applied_at_version)
          values (${migration.name}, ${options.schemaVersion})`;
      },
    });
    info("Core migration applied", {
      "db.schema": CORE_SCHEMA,
      "core.migration": migration.name,
      "core.migration_file": migration.file,
      "core.migration_type": "incremental",
      "core.schema_version": options.schemaVersion,
    });
  }

  const sorted2 = [...idempotents].sort((a, b) => a.name.localeCompare(b.name));

  for (const migration of sorted2) {
    await span("core.migrate.idempotent", {
      attributes: {
        "db.schema": CORE_SCHEMA,
        "core.migration": migration.name,
        "core.migration_file": migration.file,
        "core.migration_type": "idempotent",
        "core.schema_version": options.schemaVersion,
      },
      callback: () =>
        executeSqlFile(
          tx,
          options,
          "idempotent",
          migration.file,
          migration.sql,
        ),
    });
  }

  await tx`update core.version set version = ${options.schemaVersion}, at = now()`;
}

async function executeSqlFile(
  tx: SQL,
  options: NormalizedMigrateCoreOptions,
  type: string,
  file: string,
  sqlText: string,
): Promise<void> {
  logSqlFile(options, type, file);
  try {
    await tx.unsafe(sqlText);
  } catch (error) {
    logSqlExecutionError(options, type, file, sqlText, error);
    throw error;
  }
}

function logSqlFile(
  options: NormalizedMigrateCoreOptions,
  type: string,
  file: string,
): void {
  if (!options.logSqlFiles) return;
  console.error(`[migrate:db] core ${type} packages/core/migrate/${file}`);
}

function logSqlExecutionError(
  options: NormalizedMigrateCoreOptions,
  type: string,
  file: string,
  sqlText: string,
  error: unknown,
): void {
  if (!options.logSqlFiles) return;
  console.error(
    `[migrate:db] failed core ${type} packages/core/migrate/${file}`,
  );
  logPostgresSqlLocation(sqlText, error);
}

function logPostgresSqlLocation(sqlText: string, error: unknown): void {
  if (!(error instanceof SQL.PostgresError)) return;
  const position = Number(error.position);
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

async function assertSchemaOwnership(tx: SQL): Promise<void> {
  const [result] = await tx`
    select
      n.nspowner = (select pg_catalog.to_regrole(current_user)::oid) as is_owner
    from pg_catalog.pg_namespace n
    where n.nspname = ${CORE_SCHEMA}
  `;

  if (!result?.is_owner) {
    throw new Error(
      "Only the owner of the core schema can run database migrations",
    );
  }
}
